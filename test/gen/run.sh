#!/usr/bin/env bash
# thcli +gen 端到端测试脚本
#
# 用法:
#   bash run.sh                    # local：本地校验 + 全部请求体断言（--dry-run，零费用，不联网提交）
#   bash run.sh --server           # + server：真实提交，断言「服务端受理 + 字段进请求体」（异步只提交，扣少量费）
#   bash run.sh --all              # + real：真实素材端到端生成，结果落盘 $R_OUT（扣费）
#   bash run.sh --all --verify     # 再并发等待所有异步任务出结果，统计真实成败（厂商偶发错误自动重提 1 次）
#   bash run.sh --dry-run          # 打印每个用例的命令与最终请求体（零费用）
#   bash run.sh --sync-assets      # 先把用到的 test/assets 素材上传到 COS，再跑
#   bash run.sh --only <正则>      # 只跑 ID 匹配的用例，如 --only 'real-|vid-kling'
#
# 层级（run_case 第 2 个参数）:
#   local   不联网：本地校验、help、models、任务列表等，原样执行
#   body    只看请求体：任何模式都追加 --dry-run（用于含占位 ID、无法真实受理的字段，如 element_id）
#   server  local 模式下追加 --dry-run 只断言请求体；--server/--all 下真实提交，要求退出码 0
#   real    仅 --all：真实素材端到端，要求退出码 0
#
# 断言（run_case 第 3 个参数）:
#   fail:<文案>   退出码非 0 且输出含 <文案>（本地拦截）
#   field:<文案>  输出（请求体 / --verbose / help）含 <文案>；server 层真实提交时还要求退出码 0
#   ok            退出码 0
#
# 素材: 全部取自 test/assets。可收本地文件的字段传本地路径（CLI 自动编码）；只收公网 URL 的字段
#   用同一素材在 COS 上的副本 $ASSET_URL/<相对 test/assets 的路径>（--sync-assets 上传）。
#
# 前置: thcli auth login 配好数据面 Key；thcli 在 PATH 或设 THCLI=/path/to/thcli
set -uo pipefail
# 先拷贝快照再执行：运行期间脚本被修改也不会读错位（bash 边读边执行）
if [ -z "${RUN_SH_DIR:-}" ]; then
  RUN_SH_DIR=$(cd "$(dirname "$0")" && pwd); export RUN_SH_DIR
  snap=$(mktemp /tmp/thcli-run.XXXXXX.sh); cp "$0" "$snap"
  exec bash "$snap" "$@"
fi
cd "$RUN_SH_DIR" || exit 1   # 统一 cwd，保证 ../assets/... 相对路径正确

THCLI=${THCLI:-thcli}
# 断言按中文文案写：固定界面语言，不受本机 thcli lang set 影响
export THCLI_LANG=zh
MODE=local
DRY_RUN=0
VERIFY=0
SYNC_ASSETS=0
ONLY=${ONLY:-}
while [ $# -gt 0 ]; do
  case "$1" in
    --server) MODE=server ;;
    --all) MODE=all ;;
    --dry-run) DRY_RUN=1 ;;
    --verify) VERIFY=1 ;;
    --sync-assets) SYNC_ASSETS=1 ;;
    --only) shift; ONLY=${1:-} ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "未知参数: $1（bash run.sh --help）"; exit 2 ;;
  esac
  shift
done
VERIFY_TIMEOUT=${VERIFY_TIMEOUT:-1200}
VERIFY_JOBS=${VERIFY_JOBS:-8}
RETRY_429=${RETRY_429:-6}       # 提交撞并发上限时最多重提次数
RETRY_WAIT=${RETRY_WAIT:-30}    # 每次重提前等待秒数
CONCURRENCY_RE=${CONCURRENCY_RE:-'HTTP 429|RequestLimitExceeded|maximum concurrency|任务上限|并发'}
# 厂商侧偶发错误（超时、system error）：verify 时自动重提一次
TRANSIENT_RE=${TRANSIENT_RE:-'deadline exceeded|timeout|Timeout|system error|ServerError|InternalError|网络|稍后重试'}

# ---------------- 真实素材（test/assets） ----------------
A=../assets
ASSET_URL=${ASSET_URL:-https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets}
ASSET_COS=${ASSET_COS:-cos://test-bucket/thcli-assets}
# 本地文件（可收 Base64 的字段）
CAT=$A/images/cat-window.jpg          # 1920x1280 猫
LAND=$A/images/landscape-b.jpg        # 1920x1280 风景
CORGI=$A/images/corgi.jpg             # 柯基（主体参考）
FACE=$A/images/portrait.jpg           # 人像
FACE2=$A/images/portrait-2.jpg        # 人像 2
ROOM=$A/images/room.jpg               # 室内（全景 / 3D 场景）
SNEAKER=$A/images/sneaker.png         # 商品图（3D / 水印）
SNEAKER_A=$A/images/sneaker-alpha.png # 同一商品图去背景（含透明像素，透明背景生成用）
WAV=$A/audio/speech-zh-10s.wav        # 中文语音 10s（ASR / 驱动音频）
WAV30=$A/audio/speech-zh-30s.wav      # 中文语音 30s
REF=$A/audio/ref6s.mp3                # 复刻参考音 6s
DUB=$A/videos/dub-video.mp4           # 配音视频 31s
# 同一份素材的公网 URL（只收 URL 的字段）
U() { printf '%s/%s' "$ASSET_URL" "$1"; }
CAT_URL=$(U images/cat-window.jpg)
LAND_URL=$(U images/landscape-b.jpg)
CORGI_URL=$(U images/corgi.jpg)
FACE_URL=$(U images/portrait.jpg)
FACE2_URL=$(U images/portrait-2.jpg)
ROOM_URL=$(U images/room.jpg)
SNEAKER_URL=$(U images/sneaker.png)
COURT_URL=$(U images/courtyard.jpg)
DANCE_URL=$(U videos/dance-8s.mp4)          # 1280x720 8s 远景群舞（kling omni 编辑底片）
DANCE5_URL=$(U videos/dance-5s.mp4)         # 同一舞蹈截 5s（vidu 视频参考要求 ≤5s）
CITY_URL=$(U videos/city-timelapse-10s.mp4) # 10s 延时；SAR=12800:12803 不是 1:1，不能做 Kling omni 参考视频（服务端报 PAR should be 1:1）
H3VID_URL=$(U videos/h3-refaudio.mp4)       # 1024x768 6.5s 单人半身（H3 参考视频 / kling 动作参考）
DUB_URL=$(U videos/dub-video.mp4)
WAV_URL=$(U audio/speech-zh-10s.wav)
WAV30_URL=$(U audio/speech-zh-30s.wav)
REF_URL=$(U audio/ref6s.mp3)
ASSET_FILES=(images/sneaker-alpha.png images/cat-window.jpg images/landscape-b.jpg images/corgi.jpg images/portrait.jpg images/portrait-2.jpg
  images/room.jpg images/sneaker.png images/courtyard.jpg videos/dance-8s.mp4 videos/dance-5s.mp4 videos/city-timelapse-10s.mp4
  videos/h3-refaudio.mp4 videos/dub-video.mp4 audio/speech-zh-10s.wav audio/speech-zh-30s.wav audio/ref6s.mp3)

if [ "$SYNC_ASSETS" = 1 ]; then
  echo "== 同步素材到 $ASSET_COS =="
  for f in "${ASSET_FILES[@]}"; do
    coscli cp "$A/$f" "$ASSET_COS/$f" >/dev/null 2>&1 && echo "  up  $f" || { echo "  FAIL $f"; exit 1; }
  done
fi
if [ "$DRY_RUN" != 1 ] && [ "$MODE" != local ]; then
  for f in "${ASSET_FILES[@]}"; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -r 0-0 --max-time 15 "$(U "$f")")
    case "$code" in 200|206) ;; *) echo "素材不可访问（HTTP $code）: $(U "$f")；先跑 bash run.sh --sync-assets"; exit 1 ;; esac
  done
fi

PASS=0; FAIL=0; SKIP=0; FAILED=()
declare -A TIER_PASS=() TIER_FAIL=()
TASKS=()   # 异步提交：「用例ID|接口|任务ID|用例序号」，--verify 用
CMDS=()    # 用例序号 → 原始命令（%q 序列化），verify 重提用

# 输出里最有信息量的几行（跳过 Request ID）
reason_of() { printf '%s' "$1" | grep -vE '^Request ID' | grep -m3 -E 'Error|响应详情|厂商错误码|错误码|error' | tr '\n' ' ' | cut -c1-220; }

run_case() {
  local id="$1" tier="$2" expect="$3" desc="$4"; shift 4
  if [ -n "$ONLY" ] && ! [[ "$id" =~ $ONLY ]]; then return 0; fi
  # 是否追加 --dry-run（只看请求体）
  local dry=0 enabled=1
  case "$tier" in
    local) ;;
    body) dry=1 ;;
    server) [ "$MODE" = local ] && dry=1 ;;
    real) [ "$MODE" = all ] || enabled=0 ;;
  esac
  [ "$DRY_RUN" = 1 ] && [ "$tier" != local ] && dry=1
  if [ "$DRY_RUN" = 1 ]; then
    printf '\n### [%s] %s\n' "$id" "$desc"
    printf 'CMD:'; printf ' %q' "$@"; printf '\n'
    if [ "$dry" = 1 ]; then "$@" --dry-run 2>&1; else [ "$tier" = local ] && "$@" 2>&1; fi
    return 0
  fi
  if [ "$enabled" != 1 ]; then
    SKIP=$((SKIP+1)); printf '  SKIP %-16s %s\n' "$id" "$desc"; return 0
  fi
  local cmd_q; cmd_q=$(printf '%q ' "$@")
  local out code=0 live=0
  [ "$dry" = 0 ] && [ "$tier" != local ] && live=1
  if [ "$dry" = 1 ]; then out=$("$@" --dry-run 2>&1); code=$?; else out=$("$@" 2>&1); code=$?; fi
  # 真实提交撞上厂商并发上限（HTTP 429 / RequestLimitExceeded）：退避后重提
  local n=0
  while [ "$live" = 1 ] && [ "$code" -ne 0 ] && [ "$n" -lt "$RETRY_429" ] && printf '%s' "$out" | grep -qE "$CONCURRENCY_RE"; do
    n=$((n+1)); printf '  ...  %-16s 并发上限，%ss 后重提（%s/%s）\n' "$id" "$RETRY_WAIT" "$n" "$RETRY_429"
    sleep "$RETRY_WAIT"; out=$("$@" 2>&1); code=$?
  done
  local ok=0
  case "$expect" in
    fail:*) { [ "$code" -ne 0 ] && printf '%s' "$out" | grep -qF -- "${expect#fail:}"; } && ok=1 ;;
    field:*) printf '%s' "$out" | grep -qF -- "${expect#field:}" && { [ "$live" = 0 ] || [ "$code" -eq 0 ]; } && ok=1 ;;
    ok) [ "$code" -eq 0 ] && ok=1 ;;
  esac
  local label=$tier; [ "$dry" = 1 ] && [ "$tier" = server ] && label=body
  if [ "$ok" = 1 ]; then
    PASS=$((PASS+1)); TIER_PASS[$label]=$(( ${TIER_PASS[$label]:-0} + 1 ))
    printf '  PASS %-16s %s\n' "$id" "$desc"
    if [ "$live" = 1 ]; then
      local q
      q=$(printf '%s' "$out" | grep -oE 'thcli \+gen status [a-z0-9_/.-]+ [A-Za-z0-9_-]{6,}' | head -1)
      if [ -n "$q" ]; then
        local ep tid
        ep=$(printf '%s' "$q" | awk '{print $4}'); tid=$(printf '%s' "$q" | awk '{print $5}')
        CMDS+=("$cmd_q")
        TASKS+=("$id|$ep|$tid|$(( ${#CMDS[@]} - 1 ))")
      fi
    fi
  else
    FAIL=$((FAIL+1)); FAILED+=("$id"); TIER_FAIL[$label]=$(( ${TIER_FAIL[$label]:-0} + 1 ))
    printf '  FAIL %-16s %s  (expect %s)\n' "$id" "$desc" "$expect"
    printf '       → %s\n' "$(reason_of "$out")"
  fi
  return 0
}

echo "== thcli +gen 端到端测试（层级: $MODE）=="

# ================= image =================
echo "-- image --"
run_case img-hyv3-08   local "fail:--prompt 必填"            "hy-v3 缺 --prompt" \
  "$THCLI" +gen wand/hunyuan-image/v3-generation --model hy-image-v3
run_case img-hyv3-02   server "field:size"                  "hy-v3 --size" \
  "$THCLI" +gen wand/hunyuan-image/v3-generation --model hy-image-v3 --prompt 猫 --size 1024x1024 --verbose
run_case img-hyv3-07   server "field:revise"                "hy-v3 组合(images/seed/revise/footnote/size)" \
  "$THCLI" +gen wand/hunyuan-image/v3-generation --model hy-image-v3 --prompt 猫 --images "$CAT" --size 1024x1024 --seed 1 --footnote x --revise true --verbose
run_case img-hyv35-01  server "field:messages"              "hy-v3.5 --messages（文本 + 本地参考图）" \
  "$THCLI" +gen wand/hunyuan-image/v35-generation --model hy-image-v3.5-preview --messages "[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"改成夜景\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"$CAT\"}}]}]" --verbose
run_case img-hyv35-02  server "field:generate_max_pixels"   "hy-v3.5 --generate-max-pixels" \
  "$THCLI" +gen wand/hunyuan-image/v35-generation --model hy-image-v3.5-preview --messages '[{"role":"user","content":[{"type":"text","text":"猫"}]}]' --generate-max-pixels 4194304 --verbose
run_case img-hyv35-07  server "field:use_search_tool"       "hy-v3.5 --use-search-tool" \
  "$THCLI" +gen wand/hunyuan-image/v35-generation --model hy-image-v3.5-preview --messages '[{"role":"user","content":[{"type":"text","text":"猫"}]}]' --use-search-tool '{"value":true}' --verbose
run_case img-seed-03   server "field:layer_decomposition"   "seedream --layer-decomposition" \
  "$THCLI" +gen wand/si-image/generation --model seedream-image-v5.0-pro --prompt 把猫和背景分层 --images "$CAT" --layer-decomposition true --verbose
run_case img-seed-04   server "field:background"            "seedream --background transparent" \
  "$THCLI" +gen wand/si-image/generation --model seedream-image-v5.0-pro --prompt 生成这双鞋的透明背景商品图 --images "$SNEAKER_A" --background transparent --verbose
run_case img-seed-06   server "field:sequential_image_generation" "seedream lite 组图" \
  "$THCLI" +gen wand/si-image/generation --model seedream-image-v5.0-lite --prompt 猫 --sequential-image-generation auto --sequential-image-generation-options '{"max_images":4}' --verbose
run_case img-seed-07   server "field:tools"                 "seedream lite --tools web_search" \
  "$THCLI" +gen wand/si-image/generation --model seedream-image-v5.0-lite --prompt 猫 --tools '{"type":"web_search"}' --verbose
run_case img-seed-10   local "fail:仅 seedream-image-v5.0-lite" "seedream pro 传 lite 专属字段" \
  "$THCLI" +gen wand/si-image/generation --model seedream-image-v5.0-pro --prompt 猫 --tools '{"type":"web_search"}'
# --param / --body 覆盖层：接口参数 < --param < --body；= 传字符串、:= 传 JSON；model 以最终请求体为准做白名单校验
run_case gen-param-01  local 'field:"size": "1K"'             "--param 覆盖接口参数" \
  "$THCLI" +gen wand/si-image/generation --model seedream-image-v5.0-pro --prompt 猫 --size 2K --param size=1K --dry-run
run_case gen-param-02  local 'field:"new_id": "123"'         "--param key=value 传字符串" \
  "$THCLI" +gen wand/si-image/generation --model seedream-image-v5.0-pro --prompt 猫 --param new_id=123 --dry-run
run_case gen-param-03  local 'field:"n": 2'                  "--param key:=json 传 JSON" \
  "$THCLI" +gen wand/si-image/generation --model seedream-image-v5.0-pro --prompt 猫 --param n:=2 --dry-run
run_case gen-body-01   local 'field:"prompt": "模板"'        "--body 覆盖 --prompt 与 --param" \
  "$THCLI" +gen wand/si-image/generation --model seedream-image-v5.0-pro --prompt 猫 --param prompt=狗 --body '{"prompt":"模板"}' --dry-run
run_case gen-body-02   local "fail:kling-video-v3"           "--body 的 model 不在接口白名单被拦" \
  "$THCLI" +gen wand/si-image/generation --prompt 猫 --body '{"model":"kling-video-v3"}' --dry-run
# +gen 帮助与任务列表：help <子命令> 写法、总览列出子命令、status 不收提交类选项、tasks 参数校验（均不发请求）
run_case gen-help-01   local "field:thcli +gen status"       "+gen help status 显示 status 帮助" \
  "$THCLI" +gen help status
run_case gen-help-02   local "field:tasks"                   "+gen help 总览列出 tasks 子命令" \
  "$THCLI" +gen help
run_case gen-help-03   local "field:thcli +gen status wand/vidu/text-to-video" "异步接口帮助给出查询命令" \
  "$THCLI" +gen wand/vidu/text-to-video --help
run_case gen-help-04   local "field:--input-url"             "Tenlai 异步 ASR 帮助含二选一字段" \
  "$THCLI" +gen tenlai/asrproxy/create_rec_task --help
run_case gen-help-05   local "field:--styles"                "Mureka easy 帮助含风格枚举" \
  "$THCLI" +gen wand/mureka-music/easy-generation --help
run_case gen-status-01 local "fail:--param"                  "status 不收 --param" \
  "$THCLI" +gen status wand/vidu/text-to-video x --param a=1
run_case gen-tasks-01  local "fail:--limit"                  "tasks --limit 非正整数被拦" \
  "$THCLI" +gen tasks --limit 0
# Kling omni：aspect_ratio 仅在有首帧时可省略；base_video / feature_video 场景必传
run_case gen-omni-ratio-01 local "fail:base_video 时也须指定"      "omni base_video 缺 aspect_ratio 本地拦" \
  "$THCLI" +gen wand/kling/omni-video --model kling-video-v3-omni --contents '[{"type":"prompt","text":"夜景"},{"type":"base_video","url":"https://x/in.mp4"}]' --dry-run
run_case gen-omni-ratio-02 local "fail:feature_video 时也须指定"   "omni feature_video 缺 aspect_ratio 本地拦" \
  "$THCLI" +gen wand/kling/omni-video --model kling-video-v3-omni --contents '[{"type":"prompt","text":"x"},{"type":"feature_video","url":"https://x/in.mp4"}]' --dry-run
run_case img-vidu-02   server "field:aspect_ratio"          "vidu-image --aspect-ratio" \
  "$THCLI" +gen wand/vidu-image/generation --model vidu-image-q2 --prompt 猫 --aspect-ratio 16:9 --no-wait --verbose
run_case img-vidu-05   server "field:callback_url"          "vidu-image --callback-url" \
  "$THCLI" +gen wand/vidu-image/generation --model vidu-image-q2 --prompt 猫 --callback-url https://example.com/cb --no-wait --verbose
run_case img-kling-06  body   "field:element_list"          "kling-image --element-list" \
  "$THCLI" +gen wand/kling-image/generation --model kling-image-v3-omni --prompt 猫 --element-list '[{"element_id":"id1"},{"element_id":"id2"}]' --no-wait --verbose
run_case img-kling-07  server "field:series_amount"         "kling-image 组图 series" \
  "$THCLI" +gen wand/kling-image/generation --model kling-image-v3-omni --prompt 以这只猫为主角画四格漫画 --image-list "$CAT" --result-type series --series-amount 4 --no-wait --verbose
run_case img-kling-09  local "fail:--image-list 仅" "kling-image-v3 不收 image_list" \
  "$THCLI" +gen wand/kling-image/generation --model kling-image-v3 --prompt 猫 --image-list "[\"$CAT\",\"$LAND\"]"
run_case img-kling-10  server "field:image_list"            "kling-image-o1 多图 image_list" \
  "$THCLI" +gen wand/kling-image/generation --model kling-image-o1 --prompt 猫坐在这片风景里 --image-list "[\"$CAT\",\"$LAND\"]" --no-wait --verbose
run_case img-kling-08  server "field:watermark_info"        "kling-image --watermark-info" \
  "$THCLI" +gen wand/kling-image/generation --model kling-image-v3 --prompt 改成水彩画风 --image "$CAT" --watermark-info '{"enabled":true}' --no-wait --verbose

# ================= video =================
echo "-- video --"
run_case vid-hy-08   server "field:negative_prompt"         "hy-video 组合" \
  "$THCLI" +gen wand/hunyuan-video/generation --model hy-video-v1.5 --prompt 猫 --duration 5 --resolution 720p --negative-prompt x --seed 1 --no-wait --verbose
run_case vid-hy-09   local "fail:仅文生视频支持"            "hy-video 图生不收 aspect_ratio" \
  "$THCLI" +gen wand/hunyuan-video/generation --model hy-video-v1.5 --image "$CAT" --aspect-ratio 16:9
run_case vid-kling-01 server "field:text-to-video"          "kling 文生" \
  "$THCLI" +gen wand/kling/text-to-video --model kling-video-v3 --prompt 猫 --settings '{"duration":5}' --no-wait --verbose
run_case vid-kling-02 server "field:first_frame"            "kling 图生（本地首帧）" \
  "$THCLI" +gen wand/kling/image-to-video --model kling-video-v3 --contents "[{\"type\":\"prompt\",\"text\":\"猫转头看向窗外\"},{\"type\":\"first_frame\",\"url\":\"$CAT\"}]" --no-wait --verbose
run_case vid-kling-03 server "field:last_frame"             "kling 首尾帧" \
  "$THCLI" +gen wand/kling/image-to-video --model kling-video-v3 --contents "[{\"type\":\"prompt\",\"text\":\"镜头从猫推向窗外风景\"},{\"type\":\"first_frame\",\"url\":\"$CAT\"},{\"type\":\"last_frame\",\"url\":\"$LAND\"}]" --no-wait --verbose
run_case vid-kling-06 server "field:audio"                  "kling --settings audio" \
  "$THCLI" +gen wand/kling/text-to-video --model kling-video-v3 --prompt 猫 --settings '{"audio":"native"}' --no-wait --verbose
run_case vid-kling-07 server "field:multi_shot"             "kling --settings multi_shot" \
  "$THCLI" +gen wand/kling/text-to-video --model kling-video-v3 --prompt 猫 --settings '{"multi_shot":false}' --no-wait --verbose
run_case vid-kling-10 local "fail:未知字段「aspect_ratio」" "kling 图生 settings 不收 aspect_ratio" \
  "$THCLI" +gen wand/kling/image-to-video --model kling-video-v3 --contents "[{\"type\":\"first_frame\",\"url\":\"$CAT\"}]" --settings '{"aspect_ratio":"16:9"}'
run_case vid-omni-02  local "fail:aspect_ratio"             "omni 无首帧无 aspect_ratio" \
  "$THCLI" +gen wand/kling/omni-video --model kling-video-v3-omni --contents '[{"type":"prompt","text":"猫"}]'
run_case vid-omni-03  server "field:base_video"             "omni base_video 编辑（audio=native 不兼容 base_video，Kling 1201）" \
  "$THCLI" +gen wand/kling/omni-video --model kling-video-v3-omni --contents "[{\"type\":\"prompt\",\"text\":\"把背景换成夜景\"},{\"type\":\"base_video\",\"url\":\"$DANCE_URL\"}]" --settings '{"aspect_ratio":"16:9"}' --no-wait --verbose
run_case vid-omni-04  local "fail:5 或 10 秒"               "o1 duration 非法" \
  "$THCLI" +gen wand/kling/omni-video --model kling-video-o1 --contents '[{"type":"prompt","text":"猫"}]' --settings '{"aspect_ratio":"16:9","duration":8}'
run_case vid-motion-02 local "fail:type=\"image\""          "motion-control 缺形象图" \
  "$THCLI" +gen wand/kling/motion-control --model kling-video-motion-control-v3.0 --contents "[{\"type\":\"video\",\"url\":\"$H3VID_URL\"}]" --settings '{"character_orientation":"image"}'
run_case vid-motion-03 local "fail:type=\"video\""          "motion-control 缺动作视频" \
  "$THCLI" +gen wand/kling/motion-control --model kling-video-motion-control-v3.0 --contents "[{\"type\":\"image\",\"url\":\"$CAT\"}]" --settings '{"character_orientation":"image"}'
run_case vid-motion-01 server "field:character_orientation" "motion-control 全量" \
  "$THCLI" +gen wand/kling/motion-control --model kling-video-motion-control-v3.0 --contents "[{\"type\":\"prompt\",\"text\":\"复刻舞蹈动作\"},{\"type\":\"image\",\"url\":\"$FACE_URL\"},{\"type\":\"video\",\"url\":\"$H3VID_URL\"}]" --settings '{"character_orientation":"image"}' --no-wait --verbose
run_case vid-vidu-01 server "field:text-to-video"           "vidu 文生" \
  "$THCLI" +gen wand/vidu/text-to-video --model vidu-video-q3-turbo --prompt 猫 --aspect-ratio 16:9 --no-wait --verbose
run_case vid-vidu-02 server "field:image-to-video"          "vidu 图生（本地首帧）" \
  "$THCLI" +gen wand/vidu/image-to-video --model vidu-video-q3-turbo --prompt 猫伸懒腰 --images "$CAT" --no-wait --verbose
run_case vid-vidu-03 server "field:start-end-to-video"      "vidu 首尾帧" \
  "$THCLI" +gen wand/vidu/start-end-to-video --model vidu-video-q3-turbo --prompt 镜头从猫推向窗外风景 --images "[\"$CAT\",\"$LAND\"]" --no-wait --verbose
run_case vid-vidu-04 server "field:reference-to-video"      "vidu 参考生方式二（images）" \
  "$THCLI" +gen wand/vidu/reference-to-video --model vidu-video-q3-turbo --prompt 两个女孩在窗边 --images "[\"$FACE\",\"$FACE2\"]" --no-wait --verbose
run_case vid-vidu-05 server "field:subjects"                "vidu 参考生方式一（subjects）" \
  "$THCLI" +gen wand/vidu/reference-to-video --model vidu-video-q3-turbo --prompt '@girl 转身' --subjects "[{\"name\":\"girl\",\"images\":[\"$FACE_URL\"]}]" --no-wait --verbose
run_case vid-vidu-06 local "fail:--images 必填"             "vidu 图生缺首帧" \
  "$THCLI" +gen wand/vidu/image-to-video --model vidu-video-q3-turbo --prompt 猫
run_case vid-vidu-07 local "fail:不是已知接口"             "vidu 未知接口" \
  "$THCLI" +gen wand/vidu/foo --model vidu-video-q3
run_case vid-vidu-08 local "fail:不在接口"                  "vidu q3 不支持文生接口" \
  "$THCLI" +gen wand/vidu/text-to-video --model vidu-video-q3 --prompt 猫
run_case vid-vidu-09 server "field:style"                   "vidu --style" \
  "$THCLI" +gen wand/vidu/text-to-video --model vidu-video-q3-turbo --prompt 猫 --style anime --no-wait --verbose
run_case vid-vidu-10 server "field:audio"                   "vidu --audio" \
  "$THCLI" +gen wand/vidu/text-to-video --model vidu-video-q3-turbo --prompt 猫 --audio true --audio-type all --no-wait --verbose
run_case vid-vidu-13 server "field:movement_amplitude"      "vidu --movement-amplitude" \
  "$THCLI" +gen wand/vidu/text-to-video --model vidu-video-q3-turbo --prompt 猫 --movement-amplitude large --no-wait --verbose
run_case vid-vidu-15 server "field:videos"                  "vidu reference --videos（仅 q2-pro）" \
  "$THCLI" +gen wand/vidu/reference-to-video --model vidu-video-q2-pro --prompt 参考视频动作 --videos "[\"$DANCE5_URL\"]" --no-wait --verbose
run_case vid-vidu-16 server "field:wm_url"                  "vidu 水印组" \
  "$THCLI" +gen wand/vidu/text-to-video --model vidu-video-q3-turbo --prompt 猫 --watermark true --wm-url $SNEAKER_URL --wm-position 1 --no-wait --verbose
run_case vid-vidu-17 local "fail:--prompt 必填"             "vidu reference 缺 prompt" \
  "$THCLI" +gen wand/vidu/reference-to-video --model vidu-video-q3 --images "$CAT"
run_case vid-vidu-18 local "fail:恰好选一种"                "vidu subjects+images 互斥" \
  "$THCLI" +gen wand/vidu/reference-to-video --model vidu-video-q3 --prompt p --subjects '[{"name":"g"}]' --images "$CAT"
run_case vid-pix-01  server "field:quality"                 "pixverse 文生" \
  "$THCLI" +gen wand/pixverse/text-to-video --model pixverse-video-v6.0 --prompt 猫 --duration 5 --quality 720p --no-wait --verbose
run_case vid-pix-02  server "field:img_id"                  "pixverse 图生" \
  "$THCLI" +gen wand/pixverse/image-to-video --model pixverse-video-v6.0 --prompt 猫伸懒腰 --img-id "$CAT" --duration 5 --quality 720p --no-wait --verbose
run_case vid-pix-03  server "field:first_frame_img"         "pixverse 首尾帧" \
  "$THCLI" +gen wand/pixverse/start-end-to-video --model pixverse-video-v6.0 --prompt 镜头从猫推向窗外风景 --first-frame-img "$CAT" --last-frame-img "$LAND" --duration 5 --quality 720p --no-wait --verbose
run_case vid-pix-04  server "field:image_references"        "pixverse 参考生" \
  "$THCLI" +gen wand/pixverse/reference-to-video --model pixverse-video-v6.0 --prompt '@dog 在草地上跑' --image-references "[{\"img_id\":\"$CORGI\",\"type\":\"subject\",\"ref_name\":\"dog\"}]" --duration 5 --quality 720p --no-wait --verbose
run_case vid-pix-05  server "field:camera_movement"         "pixverse --camera-movement" \
  "$THCLI" +gen wand/pixverse/text-to-video --model pixverse-video-v6.0 --prompt 猫 --camera-movement zoom_in --duration 5 --quality 720p --no-wait --verbose
run_case vid-pix-07  server "field:generate_multi_clip_switch" "pixverse --generate-multi-clip-switch" \
  "$THCLI" +gen wand/pixverse/text-to-video --model pixverse-video-v6.0 --prompt 猫 --generate-multi-clip-switch true --duration 5 --quality 720p --no-wait --verbose
run_case vid-pix-08  local "fail:--quality 必填"            "pixverse 缺 quality" \
  "$THCLI" +gen wand/pixverse/text-to-video --model pixverse-video-v6.0 --prompt 猫 --duration 5
run_case vid-mm1-04  server "field:prompt_optimizer"        "minimax-v1 --prompt-optimizer" \
  "$THCLI" +gen wand/minimax-video/generation --model minimax-video-v2.3 --prompt 猫 --prompt-optimizer true --no-wait --verbose
run_case vid-mm1-05  server "field:first_frame_image"       "minimax-v1 首帧（本地）" \
  "$THCLI" +gen wand/minimax-video/generation --model minimax-video-v2.3-fast --prompt 猫伸懒腰 --first-frame-image "$CAT" --no-wait --verbose
run_case vid-mm2-03  server "field:reference_video"         "minimax-h3 --content 参考视频" \
  "$THCLI" +gen wand/minimax-video-v2/generation --model minimax-video-h3 --content "[{\"type\":\"text\",\"text\":\"参考视频的舞蹈动作\"},{\"type\":\"video_url\",\"video_url\":{\"url\":\"$H3VID_URL\"},\"role\":\"reference_video\"}]" --resolution 768P --duration 6 --no-wait --verbose
run_case vid-mm2-04  server "field:prompt_expansion_mode"   "minimax-h3 --extra" \
  "$THCLI" +gen wand/minimax-video-v2/generation --model minimax-video-h3 --content '[{"type":"text","text":"猫"}]' --ratio 16:9 --resolution 768P --duration 6 --extra '{"prompt_expansion_mode":"quality"}' --no-wait --verbose
run_case vid-wand-02 server "field:return_last_frame"       "wand-video --options" \
  "$THCLI" +gen wand/vega-videos/tasks --model wand-vega-video-1.0-lite --content '[{"type":"text","text":"猫"}]' --options '{"return_last_frame":true}' --no-wait --verbose
run_case vid-wand-03 local "fail:只收公网 URL"  "wand-video video_url 本地拦截（图片/音频放宽为 data URL）" \
  "$THCLI" +gen wand/vega-videos/tasks --model wand-vega-video-1.0-lite --content "[{\"type\":\"video_url\",\"video_url\":{\"url\":\"$CAT\"}}]"
run_case vid-wand-04 server "field:content"       "wand-video 本地图片首帧（data URL 放宽后提交）" \
  "$THCLI" +gen wand/vega-videos/tasks --model wand-vega-video-1.0-lite --content "[{\"type\":\"text\",\"text\":\"猫伸懒腰\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"$CAT\"},\"role\":\"first_frame\"}]" --no-wait --verbose
run_case vid-wand-05 body   "field:audio_url"     "wand-video 本地音频编码（data URL；时长须 2~15s）" \
  "$THCLI" +gen wand/vega-videos/tasks --model wand-vega-video-1.0-lite --content "[{\"type\":\"text\",\"text\":\"猫\"},{\"type\":\"audio_url\",\"audio_url\":{\"url\":\"$A/audio/commons-en-speech.mp3\"},\"role\":\"reference_audio\"}]"
# ================= 3d =================
echo "-- 3d --"
run_case 3d-hy-03   server "field:enable_pbr"               "hy-3d --enable-pbr" \
  "$THCLI" +gen api/3d/submit --model hy-3d-3.1 --prompt 狗 --enable-pbr true --no-wait --verbose
run_case 3d-hy-06   server "field:result_format"            "hy-3d --result-format（大写）" \
  "$THCLI" +gen api/3d/submit --model hy-3d-3.1 --prompt 狗 --result-format STL --no-wait --verbose
run_case 3d-hy-07   server "field:image_base64"             "hy-3d 本地图 --image-base64" \
  "$THCLI" +gen api/3d/submit --model hy-3d-3.1 --image-base64 "$SNEAKER" --no-wait --verbose
run_case 3d-hy-08   server "field:multi_view_images"        "hy-3d --multi-view-images" \
  "$THCLI" +gen api/3d/submit --model hy-3d-3.1 --image-url "$SNEAKER_URL" --multi-view-images "[{\"view_type\":\"left\",\"view_image_url\":\"$SNEAKER_URL\"}]" --no-wait --verbose
run_case 3d-hy-09   local "fail:--face-count 仅" "hy-3d express 不收 face_count" \
  "$THCLI" +gen api/3d/submit --model hy-3d-express --prompt 狗 --face-count 5000
run_case 3d-pano-03 local "fail:只收公网 URL"   "panorama 本地图拦截（只收 URL）" \
  "$THCLI" +gen wand/hunyuan-image/world2-panorama --model hy-world2-panorama --prompt 场景 --image-url $ROOM
run_case 3d-scene-03 local "fail:只收公网 URL"  "scene 本地图拦截（只收 URL）" \
  "$THCLI" +gen wand/hunyuan-video/world2-scene --model hy-world2-scene --image-url $ROOM
run_case 3d-scene-04 local "fail:之一"                      "scene 都缺" \
  "$THCLI" +gen wand/hunyuan-video/world2-scene --model hy-world2-scene

# ================= audio =================
echo "-- audio --"
run_case aud-asr-06  local "fail:之一"                      "asr 同步缺输入" \
  "$THCLI" +gen wand/asrproxy/sync_transcribe --model hy-asr-3.0-preview
run_case aud-asr-03  local "fail:只收公网 URL"  "asr 异步本地拦截（只收 URL）" \
  "$THCLI" +gen wand/asrproxy/async_create --model hy-asr-3.0-preview --input-url "$WAV" --subtitle-format srt
run_case aud-asr-05  server "field:source"                  "asr 同步本地 --data + --source" \
  "$THCLI" +gen wand/asrproxy/sync_transcribe --model hy-asr-3.0-preview --data "$WAV" --source zh --verbose
run_case aud-tenlai-01 server "field:input_url"             "天籁 ASR URL 提交（异步）" \
  "$THCLI" +gen tenlai/asrproxy/create_rec_task --input-url "$WAV30_URL" --no-wait --verbose
run_case aud-tenlai-02 local  "fail:之一"                   "天籁 ASR 缺二选一" \
  "$THCLI" +gen tenlai/asrproxy/create_rec_task
run_case aud-tenlai-03 body   "field:data"                  "天籁 ASR 本地文件 Base64" \
  "$THCLI" +gen tenlai/asrproxy/create_rec_task --data "$WAV" --verbose
run_case aud-tts-01  server "field:voice_setting"           "TTS 基础合成" \
  "$THCLI" +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 你好世界 --voice-setting '{"voice_id":"male-qn-qingse"}' --verbose
run_case aud-tts-02  local "fail:--voice-setting 必填" "TTS 缺 voice_setting" \
  "$THCLI" +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 你好
run_case aud-tts-03  body   "field:timbre_weights"          "TTS 音色混音" \
  "$THCLI" +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 你好 --voice-setting '{"voice_id":"male-qn-qingse"}' --timbre-weights '[{"voice_id":"male-qn-qingse","weight":50},{"voice_id":"female-shaonv","weight":50}]' --verbose
run_case aud-tts-04  server "field:speed"                   "TTS voice-setting 子字段 speed/vol" \
  "$THCLI" +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 你好 --voice-setting '{"voice_id":"male-qn-qingse","speed":1.5,"vol":8}' --verbose
run_case aud-tts-05  server "field:emotion"                 "TTS emotion" \
  "$THCLI" +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 你好 --voice-setting '{"voice_id":"male-qn-qingse","emotion":"happy"}' --verbose
run_case aud-tts-06  server "field:voice_modify"            "TTS --voice-modify" \
  "$THCLI" +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 你好 --voice-setting '{"voice_id":"male-qn-qingse"}' --voice-modify '{"pitch":20,"sound_effects":"robotic"}' --verbose
run_case aud-tts-07  server "field:audio_setting"           "TTS --audio-setting" \
  "$THCLI" +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 你好 --voice-setting '{"voice_id":"male-qn-qingse"}' --audio-setting '{"sample_rate":16000,"format":"wav","channel":1}' --verbose
run_case aud-tts-08  server "field:subtitle_enable"         "TTS 字幕" \
  "$THCLI" +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 你好 --voice-setting '{"voice_id":"male-qn-qingse"}' --subtitle-enable true --subtitle-type sentence --verbose
run_case aud-tts-09  server "field:output_format"           "TTS --output-format hex" \
  "$THCLI" +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 你好 --voice-setting '{"voice_id":"male-qn-qingse"}' --output-format hex --verbose
run_case aud-tts-11  server "field:aigc_watermark"          "TTS --aigc-watermark" \
  "$THCLI" +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 你好 --voice-setting '{"voice_id":"male-qn-qingse"}' --aigc-watermark true --verbose
run_case aud-tts-12  body   "field:output_format"           "TTS 默认 output_format=url（长文本 hex 会 502001）" \
  "$THCLI" +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 你好 --voice-setting '{"voice_id":"male-qn-qingse"}' --verbose
run_case aud-clone-08 local "fail:之一"                     "clone 缺音频" \
  "$THCLI" +gen wand/minimax-tts/sync_clone --model minimax-voice-clone
run_case aud-clone-02 server "field:tts_model"              "clone 本地 --audio-data + --tts-model" \
  "$THCLI" +gen wand/minimax-tts/sync_clone --model minimax-voice-clone --audio-data "$REF" --tts-model minimax-speech-2.8-turbo --verbose
run_case aud-clone-03 server "field:voice_id"               "clone --voice-id" \
  "$THCLI" +gen wand/minimax-tts/sync_clone --model minimax-voice-clone --audio-data "$REF" --voice-id "thcli_case_$(date +%m%d%H%M%S)" --verbose
run_case aud-clone-06 server "field:accuracy"               "clone --accuracy" \
  "$THCLI" +gen wand/minimax-tts/sync_clone --model minimax-voice-clone --audio-data "$REF" --accuracy 0.8 --verbose
run_case aud-clone-09 body   "field:file_id"                "clone --file-id（三选一新增）" \
  "$THCLI" +gen wand/minimax-tts/sync_clone --file-id 123 --verbose
run_case aud-clone-10 local  "fail:之一"                    "clone 缺三选一（url/data/file_id）" \
  "$THCLI" +gen wand/minimax-tts/sync_clone --model minimax-voice-clone --voice-id thcli_x
run_case aud-tts-13  body    "field:stream"                 "TTS --stream（SSE 流式，CLI 拼接）" \
  "$THCLI" +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 你好 --voice-setting '{"voice_id":"male-qn-qingse"}' --stream true --verbose
run_case aud-design-06 local "fail:--prompt 必填"           "design 缺描述" \
  "$THCLI" +gen wand/minimax-tts/sync_design --model minimax-voice-design --preview-text 你好
run_case aud-design-01 server "field:preview_text"          "design 基础" \
  "$THCLI" +gen wand/minimax-tts/sync_design --model minimax-voice-design --prompt 低沉磁性的男声 --preview-text 你好 --verbose
run_case aud-design-04 server "field:output_format"         "design --output-format" \
  "$THCLI" +gen wand/minimax-tts/sync_design --model minimax-voice-design --prompt 低沉男声 --preview-text 你好 --output-format hex --verbose
run_case aud-dub-05   local "fail:--input-url 必填"         "dub 缺视频" \
  "$THCLI" +gen wand/dubbing/async_generation --model wand-dubbing-clone-v1
run_case aud-dub-02   server "field:dst_language"           "dub 本地视频 + --dst-language" \
  "$THCLI" +gen wand/dubbing/async_generation --model wand-dubbing-clone-v1 --input-url $DUB_URL --dst-language en --no-wait --verbose
run_case aud-dub-03   server "field:src_language"           "dub --src-language" \
  "$THCLI" +gen wand/dubbing/async_generation --model wand-dubbing-clone-v1 --input-url $DUB_URL --src-language zh --no-wait --verbose
run_case aud-mm-02    server "field:lyrics"                 "minimax-music --lyrics" \
  "$THCLI" +gen wand/minimax-music/generation --model minimax-music-v3.0 --prompt 歌 --lyrics '[Verse] 歌词' --verbose
run_case aud-mm-04    server "field:is_instrumental"        "minimax-music --is-instrumental" \
  "$THCLI" +gen wand/minimax-music/generation --model minimax-music-v3.0 --prompt 钢琴 --is-instrumental true --verbose
run_case aud-mm-03    server "field:lyrics_optimizer"       "minimax-music --lyrics-optimizer" \
  "$THCLI" +gen wand/minimax-music/generation --model minimax-music-v3.0 --prompt 歌 --lyrics-optimizer true --verbose
run_case aud-mureka-01 server "field:styles"                "easy --styles（提示词成曲）" \
  "$THCLI" +gen wand/mureka-music/easy-generation --model mureka-music-v9 --prompt 一首明亮夏日氛围的情歌 --styles '["pop","rock"]' --n 1 --verbose
run_case aud-mureka-02 server "field:gender"                "generation --lyrics --gender" \
  "$THCLI" +gen wand/mureka-music/generation --model mureka-music-v9 --prompt 清新民谣 --lyrics '[Verse] 夏天的风' --gender female --n 1 --verbose
run_case aud-mureka-03 server "field:n"                     "mureka --n" \
  "$THCLI" +gen wand/mureka-music/generation --model mureka-music-v9 --lyrics '[Verse] 夏天的风' --n 1 --verbose
run_case aud-mureka-05 local  "fail:--lyrics 必填"          "generation 只传提示词本地拦（歌词成曲需 lyrics）" \
  "$THCLI" +gen wand/mureka-music/generation --model mureka-music-v9 --prompt 夏日情歌 --n 1
run_case aud-mureka-06 server "field:prompt"                "instrumental 纯音乐" \
  "$THCLI" +gen wand/mureka-music/instrumental-generation --model mureka-music-v9 --prompt 'lo-fi, cozy, warm piano' --n 1 --verbose
run_case aud-mureka-07 local "fail:--lyrics 必填"           "mureka 缺歌词" \
  "$THCLI" +gen wand/mureka-music/generation --model mureka-music-v9
run_case aud-mureka-08 body   "field:prompt"                "easy 最小调用（--prompt 必填）" \
  "$THCLI" +gen wand/mureka-music/easy-generation --model mureka-music-v9 --prompt 明亮夏日 --n 1 --verbose
run_case aud-mureka-09 local  "fail:unknown option"         "generation 无 --styles（已挪到 easy）" \
  "$THCLI" +gen wand/mureka-music/generation --model mureka-music-v9 --lyrics '[Verse] x' --styles '["pop"]' --n 1

# ================= 通用命令 =================
echo "-- 通用 --"
run_case gen-01 local ok              "列全部接口"          "$THCLI" +gen apis
run_case gen-04 local "field:wand/vidu/reference-to-video" "看 vidu 接口详情" "$THCLI" +gen apis wand/vidu/reference-to-video
run_case gen-07 local "fail:unknown option" "已删除的公共参数 --ratio" \
  "$THCLI" +gen wand/si-image/generation --model seedream-image-v5.0-pro --prompt x --ratio 16:9

# ================= 最复杂参数（真实 URL，dry-run 打印 / 实际调用） =================
echo "-- complex（最复杂参数，真实 URL）--"

run_case cplx-vidu-01 server "field:subjects" "vidu 参考生方式一（subjects 多图 + 全参数）" \
  "$THCLI" +gen wand/vidu/reference-to-video --model vidu-video-q3-turbo --prompt '@girl 转身微笑' \
  --subjects "[{\"name\":\"girl\",\"images\":[\"$FACE_URL\",\"$FACE2_URL\"]}]" \
  --movement-amplitude large --audio true --audio-type speech_only --duration 8 --resolution 1080p --seed 42 --no-wait --verbose

run_case cplx-vidu-02 server "field:reference-to-video" "vidu 参考生方式二（多图 + 视频参考 + 参数）" \
  "$THCLI" +gen wand/vidu/reference-to-video --model vidu-video-q2-pro --prompt 保持主体一致 \
  --images "[\"$FACE_URL\",\"$FACE2_URL\"]" --videos "[\"$DANCE5_URL\"]" \
  --bgm true --audio true --duration 8 --resolution 1080p --auto-subjects true --no-wait --verbose

run_case cplx-pix-01 server "field:image_references" "pixverse 参考生（image-references + 音频 + 全参数）" \
  "$THCLI" +gen wand/pixverse/reference-to-video --model pixverse-video-v6.0 --prompt '@dog 在草地奔跑' \
  --image-references "[{\"img_id\":\"$CORGI_URL\",\"type\":\"subject\",\"ref_name\":\"dog\"}]" \
  --generate-audio-switch true --duration 8 --quality 1080p --seed 42 --no-wait --verbose

run_case cplx-kling-01 body "field:series_amount" "kling 组图（series + 主体 + 水印 + 全参数）" \
  "$THCLI" +gen wand/kling-image/generation --model kling-image-v3-omni --prompt 四格漫画 \
  --result-type series --series-amount 4 \
  --element-list '[{"element_id":"id1"},{"element_id":"id2"}]' \
  --watermark-info '{"enabled":true}' --aspect-ratio 16:9 --resolution 2k --n 1 --no-wait --verbose

run_case cplx-tts-01 server "field:voice_modify" "TTS 全参数（voice + modify + audio + 字幕 + 语言增强）" \
  "$THCLI" +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text '你好，欢迎使用 TokenHub' \
  --voice-setting '{"voice_id":"male-qn-qingse","speed":1.2,"vol":8,"pitch":2,"emotion":"calm"}' \
  --voice-modify '{"pitch":20,"intensity":30,"timbre":10,"sound_effects":"robotic"}' \
  --audio-setting '{"sample_rate":16000,"bitrate":128000,"format":"wav","channel":1}' \
  --language-boost zh --subtitle-enable true --subtitle-type sentence --output-format url --aigc-watermark true --verbose

run_case cplx-h3-01 server "field:reference_video" "minimax H3 多模态（首帧 + 视频参考 + 全参数）" \
  "$THCLI" +gen wand/minimax-video-v2/generation --model minimax-video-h3 \
  --content "[{\"type\":\"text\",\"text\":\"参考视频风格\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"$FACE_URL\"},\"role\":\"reference_image\"},{\"type\":\"video_url\",\"video_url\":{\"url\":\"$H3VID_URL\"},\"role\":\"reference_video\"}]" \
  --extra '{"prompt_expansion_mode":"quality"}' --aigc-watermark true --duration 6 --resolution 768P --no-wait --verbose

run_case cplx-omni-01 server "field:base_video" "kling omni 编辑（base_video + settings）" \
  "$THCLI" +gen wand/kling/omni-video --model kling-video-v3-omni \
  --contents "[{\"type\":\"prompt\",\"text\":\"换成海边背景\"},{\"type\":\"base_video\",\"url\":\"$DANCE_URL\"}]" \
  --settings '{"resolution":"1080p","duration":5,"aspect_ratio":"16:9"}' --no-wait --verbose

# ================= real（真实素材端到端生成，扣费） =================
# 每类挑代表性接口，输入全部来自 test/assets；同步接口直接出结果，异步接口 --no-wait 提交后由 --verify 等结果。
echo "-- real（真实素材端到端生成，扣费）--"
R_OUT=${R_OUT:-/tmp/thcli-real-out}; mkdir -p "$R_OUT"
# 图像
run_case real-img-01  real ok "hy-image-v3 文生图" \
  "$THCLI" +gen wand/hunyuan-image/v3-generation --model hy-image-v3 --prompt 一只柴犬在草地上 --output "$R_OUT/real-img-01"
run_case real-img-02  real ok "seedream 本地参考图编辑" \
  "$THCLI" +gen wand/si-image/generation --model seedream-image-v5.0-pro --prompt 把这只猫改成水彩画风格 --images "$CAT" --output "$R_OUT/real-img-02"
run_case real-img-03  real ok "kling-image-o1 多图融合" \
  "$THCLI" +gen wand/kling-image/generation --model kling-image-o1 --prompt 让柯基坐在这间房间里 --image-list "[\"$CORGI\",\"$ROOM\"]" --no-wait
# 视频
run_case real-vid-01  real ok "kling 图生（本地首帧）" \
  "$THCLI" +gen wand/kling/image-to-video --model kling-video-v3 --contents "[{\"type\":\"prompt\",\"text\":\"猫转头看向窗外\"},{\"type\":\"first_frame\",\"url\":\"$CAT\"}]" --settings '{"duration":5}' --no-wait
run_case real-vid-02  real ok "kling 动作控制（人像 + 单人半身视频）" \
  "$THCLI" +gen wand/kling/motion-control --model kling-video-motion-control-v3.0 --contents "[{\"type\":\"image\",\"url\":\"$FACE_URL\"},{\"type\":\"video\",\"url\":\"$H3VID_URL\"}]" --settings '{"character_orientation":"image"}' --no-wait
run_case real-vid-03  real ok "kling omni 视频编辑" \
  "$THCLI" +gen wand/kling/omni-video --model kling-video-v3-omni --contents "[{\"type\":\"prompt\",\"text\":\"把背景换成夜景\"},{\"type\":\"base_video\",\"url\":\"$DANCE_URL\"}]" --settings '{"aspect_ratio":"16:9"}' --no-wait
run_case real-vid-04  real ok "vidu 首尾帧（本地）" \
  "$THCLI" +gen wand/vidu/start-end-to-video --model vidu-video-q3-turbo --prompt 镜头从猫推向窗外风景 --images "[\"$CAT\",\"$LAND\"]" --no-wait
run_case real-vid-05  real ok "vidu 参考生 subjects（人像 URL）" \
  "$THCLI" +gen wand/vidu/reference-to-video --model vidu-video-q3-turbo --prompt '@girl 转身微笑' --subjects "[{\"name\":\"girl\",\"images\":[\"$FACE_URL\"]}]" --no-wait
run_case real-vid-06  real ok "vidu q2-pro 参考视频" \
  "$THCLI" +gen wand/vidu/reference-to-video --model vidu-video-q2-pro --prompt 参考视频中的舞蹈动作 --images "$FACE" --videos "[\"$DANCE5_URL\"]" --no-wait
run_case real-vid-07  real ok "pixverse 主体参考（本地柯基）" \
  "$THCLI" +gen wand/pixverse/reference-to-video --model pixverse-video-v6.0 --prompt '@dog 在草地上奔跑' --image-references "[{\"img_id\":\"$CORGI\",\"type\":\"subject\",\"ref_name\":\"dog\"}]" --duration 5 --quality 720p --no-wait
run_case real-vid-08  real ok "minimax V1 首帧（本地）" \
  "$THCLI" +gen wand/minimax-video/generation --model minimax-video-v2.3-fast --prompt 猫伸懒腰 --first-frame-image "$CAT" --no-wait
run_case real-vid-09  real ok "minimax H3 参考图 + 参考视频" \
  "$THCLI" +gen wand/minimax-video-v2/generation --model minimax-video-h3 --content "[{\"type\":\"text\",\"text\":\"人物跟着参考视频跳舞\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"$FACE_URL\"},\"role\":\"reference_image\"},{\"type\":\"video_url\",\"video_url\":{\"url\":\"$H3VID_URL\"},\"role\":\"reference_video\"}]" --resolution 768P --duration 6 --no-wait
run_case real-vid-10  real ok "hy-video 图生（本地）" \
  "$THCLI" +gen wand/hunyuan-video/generation --model hy-video-v1.5 --prompt 猫伸懒腰 --image "$CAT" --no-wait
run_case real-vid-11  real ok "wand-video 首帧 URL" \
  "$THCLI" +gen wand/vega-videos/tasks --model wand-vega-video-1.0-lite --content "[{\"type\":\"text\",\"text\":\"猫伸懒腰\"},{\"type\":\"image_url\",\"image_url\":{\"url\":\"$CAT_URL\"},\"role\":\"first_frame\"}]" --no-wait
# 3D
run_case real-3d-01   real ok "hy-3d 本地商品图生 3D" \
  "$THCLI" +gen api/3d/submit --model hy-3d-3.1 --image-base64 "$SNEAKER" --no-wait
run_case real-pano-01 real ok "world2 全景（房间图）" \
  "$THCLI" +gen wand/hunyuan-image/world2-panorama --model hy-world2-panorama --prompt 温馨的客厅 --image-url "$ROOM_URL" --output "$R_OUT/real-pano-01"
run_case real-scene-01 real ok "world2 3D 场景（庭院图）" \
  "$THCLI" +gen wand/hunyuan-video/world2-scene --model hy-world2-scene --image-url "$COURT_URL" --no-wait
# 语音
run_case real-asr-01  real ok "ASR 同步（本地中文 10s）" \
  "$THCLI" +gen wand/asrproxy/sync_transcribe --model hy-asr-3.0-preview --data "$WAV" --output "$R_OUT/real-asr-01"
run_case real-asr-02  real ok "ASR 异步字幕（中文 30s URL）" \
  "$THCLI" +gen wand/asrproxy/async_create --model hy-asr-3.0-preview --input-url "$WAV30_URL" --subtitle-format srt --no-wait
run_case real-tenlai-01 real ok "天籁 ASR 异步转写（中文 30s URL）" \
  "$THCLI" +gen tenlai/asrproxy/create_rec_task --input-url "$WAV30_URL" --output "$R_OUT/real-tenlai-01"
run_case real-tts-01  real ok "TTS 合成" \
  "$THCLI" +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 你好世界 --voice-setting '{"voice_id":"male-qn-qingse"}' --output "$R_OUT/real-tts-01"
run_case real-clone-01 real ok "声音复刻（本地 6s 参考音）" \
  "$THCLI" +gen wand/minimax-tts/sync_clone --model minimax-voice-clone --audio-data "$REF" --voice-id "thcli_test_$(date +%m%d%H%M%S)" --output "$R_OUT/real-clone-01"
run_case real-dub-01  real ok "AI 配音（中文视频 → 英文）" \
  "$THCLI" +gen wand/dubbing/async_generation --model wand-dubbing-clone-v1 --input-url "$DUB_URL" --dst-language en --no-wait
run_case real-mureka-01 real ok "Mureka 歌词成曲（n=1）" \
  "$THCLI" +gen wand/mureka-music/generation --model mureka-music-v9 --prompt "pop, emotional" --lyrics '[Verse]
夜色里的城市灯火
[Chorus]
灯火 照亮我' --n 1 --output "$R_OUT/real-mureka-01"
run_case real-mureka-02 real ok "Mureka 提示词成曲（easy，n=1）" \
  "$THCLI" +gen wand/mureka-music/easy-generation --model mureka-music-v9 --prompt 一首明亮夏日氛围、带有抓耳副歌的情歌 --styles '["pop"]' --n 1 --output "$R_OUT/real-mureka-02"
run_case real-mureka-03 real ok "Mureka 纯音乐（instrumental，n=1）" \
  "$THCLI" +gen wand/mureka-music/instrumental-generation --model mureka-music-v9 --prompt "lo-fi, cozy, warm piano and soft drums" --n 1 --output "$R_OUT/real-mureka-03"

# ================= res（资源链路：生成产物 → 创建资源 → 再用于生成，顺序执行，扣费） =================
# 依赖：real-img-01/02 的产物图（创建主体）与 6s 参考音素材（创建音色，Kling 要求参考音频 ≥5s）；体现「生成的资源用于生成其他内容」
if [ "$MODE" = all ] && [ "$DRY_RUN" != 1 ]; then
  echo "-- res（资源链路，顺序执行，扣费）--"
  IMG1=$(ls "$R_OUT/real-img-01" 2>/dev/null | head -1); IMG1="$R_OUT/real-img-01/$IMG1"
  IMG2=$(ls "$R_OUT/real-img-02" 2>/dev/null | head -1); IMG2="$R_OUT/real-img-02/$IMG2"
  MP3=$(ls "$R_OUT/real-tts-01" 2>/dev/null | head -1);  MP3="$R_OUT/real-tts-01/$MP3"
  RES_ELEM=""; RES_VOICE=""
  if [ -n "$IMG1" ] && [ -n "$IMG2" ]; then
    ro=$("$THCLI" +gen resource kling-element create --images "$IMG1" --images "$IMG2" --element-name "thcli_e2e_$(date +%m%d)" --element-description "run.sh res 链路：real-img-01/02 的产物图创建的主体" 2>&1); rc=$?
    RES_ELEM=$(printf '%s' "$ro" | grep -oE '^element_id: [^[:space:]]+' | head -1 | awk '{print $2}')
    if [ "$rc" -eq 0 ] && [ -n "$RES_ELEM" ]; then PASS=$((PASS+1)); TIER_PASS[real]=$(( ${TIER_PASS[real]:-0} + 1 )); printf '  PASS %-16s %s（element_id=%s）\n' real-res-01 "element create（用 real-img-01/02 产物图）" "$RES_ELEM"
    else FAIL=$((FAIL+1)); FAILED+=(real-res-01); TIER_FAIL[real]=$(( ${TIER_FAIL[real]:-0} + 1 )); printf '  FAIL %-16s %s\n' real-res-01 "element create"; printf '       → %s\n' "$(reason_of "$ro")"; fi
  else
    SKIP=$((SKIP+1)); printf '  SKIP %-16s 前置产物缺失（real-img-01/02）\n' real-res-01
  fi
  if [ -n "$RES_ELEM" ]; then
    run_case real-res-02 real ok "kling-image-o1 用主体生成（--element-list）" \
      "$THCLI" +gen wand/kling-image/generation --model kling-image-o1 --prompt 这个人物在夕阳下的海边散步 --element-list "[{\"element_id\":\"$RES_ELEM\"}]" --no-wait
    run_case real-res-03 real ok "kling 图生视频引用主体（--contents type=element）" \
      "$THCLI" +gen wand/kling/image-to-video --model kling-video-v3 --contents "[{\"type\":\"prompt\",\"text\":\"这个人物微笑挥手\"},{\"type\":\"element\",\"element_id\":\"$RES_ELEM\"}]" --settings '{"duration":5}' --no-wait
  else SKIP=$((SKIP+2)); printf '  SKIP %-16s 无 element_id（跳过 res-02/03）\n' real-res-02; fi
  if [ -n "$MP3" ]; then
    ro=$("$THCLI" +gen resource kling-voice create --input "$REF" --voice-name "thcli_e2e_voice_$(date +%m%d)" 2>&1); rc=$?
    RES_VOICE=$(printf '%s' "$ro" | grep -oE '^voice_id: [^[:space:]]+' | head -1 | awk '{print $2}')
    if [ "$rc" -eq 0 ] && [ -n "$RES_VOICE" ]; then PASS=$((PASS+1)); TIER_PASS[real]=$(( ${TIER_PASS[real]:-0} + 1 )); printf '  PASS %-16s %s（voice_id=%s）\n' real-res-04 "voice create（6s 参考音）" "$RES_VOICE"
    else FAIL=$((FAIL+1)); FAILED+=(real-res-04); TIER_FAIL[real]=$(( ${TIER_FAIL[real]:-0} + 1 )); printf '  FAIL %-16s %s\n' real-res-04 "voice create"; printf '       → %s\n' "$(reason_of "$ro")"; fi
  else SKIP=$((SKIP+1)); printf '  SKIP %-16s 前置产物缺失（real-tts-01）\n' real-res-04; fi
  if [ -n "$RES_VOICE" ]; then
    run_case real-res-05 real ok "kling 图生视频引用自定义音色（--contents type=voice）" \
      "$THCLI" +gen wand/kling/image-to-video --model kling-video-v3 --contents "[{\"type\":\"prompt\",\"text\":\"用复刻的音色说：欢迎观看\"},{\"type\":\"first_frame\",\"url\":\"$CAT\"},{\"type\":\"voice\",\"voice_id\":\"$RES_VOICE\"}]" --settings '{"duration":5,"audio":"native"}' --no-wait
  fi
  # 收尾：真实删除刚创建的资源（云端写操作）
  if [ -n "$RES_ELEM" ]; then
    ro=$("$THCLI" +gen resource kling-element delete --element-id "$RES_ELEM" 2>&1); rc=$?
    if [ "$rc" -eq 0 ]; then PASS=$((PASS+1)); TIER_PASS[real]=$(( ${TIER_PASS[real]:-0} + 1 )); printf '  PASS %-16s 真实删除收尾（element）\n' real-res-06
    else FAIL=$((FAIL+1)); FAILED+=(real-res-06); TIER_FAIL[real]=$(( ${TIER_FAIL[real]:-0} + 1 )); printf '  FAIL %-16s resource delete（element）\n' real-res-06; printf '       → %s\n' "$(reason_of "$ro")"; fi
  fi
  if [ -n "$RES_VOICE" ]; then
    ro=$("$THCLI" +gen resource kling-voice delete --voice-id "$RES_VOICE" 2>&1); rc=$?
    if [ "$rc" -eq 0 ]; then PASS=$((PASS+1)); TIER_PASS[real]=$(( ${TIER_PASS[real]:-0} + 1 )); printf '  PASS %-16s 真实删除收尾（voice）\n' real-res-06
    else FAIL=$((FAIL+1)); FAILED+=(real-res-06); TIER_FAIL[real]=$(( ${TIER_FAIL[real]:-0} + 1 )); printf '  FAIL %-16s resource delete（voice）\n' real-res-06; printf '       → %s\n' "$(reason_of "$ro")"; fi
  fi
fi

# ================= resource 负边界（--dry-run 本地校验，零费） =================
echo "-- resource 负边界（本地校验）--"
run_case res-neg-01  body "fail:至少 2 张参考图" "element create 单图" \
  "$THCLI" +gen resource kling-element create --images "$CAT" --element-name x --element-description x
run_case res-neg-02  body "fail:最多 4 张" "element create 5 图" \
  "$THCLI" +gen resource kling-element create --images "$CAT" --images "$LAND" --images "$SNEAKER" --images "$CORGI" --images "$FACE" --element-name x --element-description x
run_case res-neg-03  body "fail:互斥" "element --images 与 --ref-video 同给" \
  "$THCLI" +gen resource kling-element create --images "$CAT" --images "$LAND" --ref-video "$DANCE_URL" --element-name x --element-description x
run_case res-neg-04  body "fail:需要 --input" "voice create 缺媒体" \
  "$THCLI" +gen resource kling-voice create --voice-name x
run_case res-neg-05  body "fail:缺少必填参数" "element create 缺 --element-name" \
  "$THCLI" +gen resource kling-element create --images "$CAT" --images "$LAND" --element-description x
run_case res-neg-06  body "fail:required option" "resource get 缺 --task-id" \
  "$THCLI" +gen resource kling-element get
run_case res-neg-07  body "fail:required option" "resource delete 缺 --element-id" \
  "$THCLI" +gen resource kling-element delete

# ================= doctor（错误码与模型体检，联网只读，零费） =================
echo "-- doctor --"
run_case doc-err-01    local ok "平台码 401002" \
  "$THCLI" doctor error 401002
run_case doc-err-02    local ok "401007（+gen 场景 fixGen）" \
  "$THCLI" doctor error 401007
run_case doc-err-03    local ok "冲突码 1002（Kling/MiniMax 并列）" \
  "$THCLI" doctor error 1002
run_case doc-err-04    local ok "vendor 全表（kling）" \
  "$THCLI" doctor error --vendor kling
run_case doc-err-05    local ok "vendor 单查（kling 1201）" \
  "$THCLI" doctor error 1201 --vendor kling
run_case doc-err-06    local ok "未收录码 999999" \
  "$THCLI" doctor error 999999
run_case doc-err-07    local "fail:未知厂商" "非法厂商" \
  "$THCLI" doctor error x --vendor foo
run_case doc-model-01  local ok "doctor model（hy-image-v3）" \
  "$THCLI" doctor model --id hy-image-v3
run_case doc-model-02  local ok "doctor model（kling-video-v3-turbo）" \
  "$THCLI" doctor model --id kling-video-v3-turbo
run_case doc-model-03  local ok "doctor model（tenlai-asr-v1.0，新模型进模型广场体检）" \
  "$THCLI" doctor model --id tenlai-asr-v1.0

# ================= act（models activate 遍历全部 +gen 模型，真实写操作） =================
if [ "$MODE" = all ] && [ "$DRY_RUN" != 1 ] && [ -z "$ONLY" ]; then
  echo "-- act（models activate 遍历全部 +gen 模型，已开模型幂等重跑）--"
  ACT_OK=0; ACT_FAIL=0; ACT_FAILED=()
  mapfile -t ACT_MODELS < <("$THCLI" +gen apis --json 2>/dev/null | node -e '
    let s=""; process.stdin.on("data", d => s+=d).on("end", () => {
      const j = JSON.parse(s); const m = new Set();
      for (const a of j) for (const x of a.Models ?? []) m.add(x);
      console.log([...m].sort().join("\n"));
    });')
  for m in "${ACT_MODELS[@]}"; do
    ao=$("$THCLI" models activate "$m" --yes 2>&1); ac=$?
    if [ "$ac" -ne 0 ]; then
      ACT_FAIL=$((ACT_FAIL+1)); ACT_FAILED+=("$m"); printf '  FAIL %-32s %s\n' "$m" "$(reason_of "$ao")"
    elif printf '%s' "$ao" | grep -q "尚无推理服务"; then
      ACT_FAIL=$((ACT_FAIL+1)); ACT_FAILED+=("$m(needEndpoint)"); printf '  FAIL %-32s 尚无推理服务，无法开启\n' "$m"
    elif printf '%s' "$ao" | grep -qE "没有待开启|已全部开启"; then
      ACT_OK=$((ACT_OK+1)); printf '  OK   %-32s（已开启，幂等）\n' "$m"
    else
      ACT_OK=$((ACT_OK+1)); printf '  OK   %-32s %s\n' "$m" "$(printf '%s' "$ao" | grep -m1 '已为' || true)"
    fi
  done
  printf '  遍历 %s 个模型：开启成功(含幂等)=%s 失败=%s\n' "${#ACT_MODELS[@]}" "$ACT_OK" "$ACT_FAIL"
fi

# ================= 负边界（status/tasks 参数校验） =================
echo "-- 负边界（status/tasks）--"
run_case neg-status-01 local "fail:本机没有任务" "status 查不存在的任务" \
  "$THCLI" +gen status wand/vidu/text-to-video e2e-not-exist-999
run_case neg-status-02 local "fail:本机没有任务" "status 查 Tenlai 不存在任务（接口路由到 POST 查询）" \
  "$THCLI" +gen status tenlai/asrproxy/create_rec_task e2e-not-exist-999
run_case neg-tasks-01  local "fail:--limit 需要正整数" "tasks --limit abc" \
  "$THCLI" +gen tasks --limit abc
# activate 无参是友好提示（exit 0），run_case 的 fail 断言要求 exit≠0，改为 shell 级验证
ao=$("$THCLI" models activate 2>&1)
if printf '%s' "$ao" | grep -q "请指定模型 ID"; then
  PASS=$((PASS+1)); TIER_PASS[local]=$(( ${TIER_PASS[local]:-0} + 1 )); printf '  PASS %-16s activate 无参提示\n' act-neg-01
else
  FAIL=$((FAIL+1)); FAILED+=(act-neg-01); TIER_FAIL[local]=$(( ${TIER_FAIL[local]:-0} + 1 )); printf '  FAIL %-16s activate 无参提示\n' act-neg-01; printf '       → %s\n' "$(reason_of "$ao")"
fi
run_case act-neg-02   local "fail:not found" "activate 不存在的模型" \
  "$THCLI" models activate no-such-model-xyz --yes

# ================= --verify：并发等待异步任务；厂商偶发错误自动重提 1 次 =================
VERIFY_OK=0; VERIFY_FAIL=0; VERIFY_FAILED=(); VERIFY_RETRIED=0
wait_one() {   # $1=用例ID $2=接口 $3=任务ID → 输出一行「状态|用例ID|说明」；产物落 $R_OUT/<用例ID>/（目录名=用例 ID，产物与用例关联）
  local o c files
  mkdir -p "$R_OUT/$1"
  o=$("$THCLI" +gen status "$2" "$3" --wait --timeout "$VERIFY_TIMEOUT" --interval 10 --output "$R_OUT/$1" 2>&1); c=$?
  if [ "$c" -eq 0 ]; then
    files=$(cd "$R_OUT/$1" && ls -1 2>/dev/null | head -4 | paste -sd' ' -)
    echo "DONE|$1|$(printf '%s' "$o" | grep -m1 -oE 'https?://[^ ?]+' | cut -c1-110)${files:+ | 产物: $files}"
  else echo "FAIL|$1|$(reason_of "$o")"; fi
}
if [ "$VERIFY" = 1 ] && [ "${#TASKS[@]}" -gt 0 ]; then
  echo ""
  echo "-- verify（${#TASKS[@]} 个异步任务，并发 $VERIFY_JOBS，单个最长 ${VERIFY_TIMEOUT}s）--"
  VDIR=$(mktemp -d /tmp/thcli-verify.XXXXXX)
  i=0
  for t in "${TASKS[@]}"; do
    IFS='|' read -r cid ep tid idx <<<"$t"
    wait_one "$cid" "$ep" "$tid" >"$VDIR/$i" &
    i=$((i+1))
    while [ "$(jobs -rp | wc -l)" -ge "$VERIFY_JOBS" ]; do sleep 2; done
  done
  wait
  i=0
  for t in "${TASKS[@]}"; do
    IFS='|' read -r cid ep tid idx <<<"$t"
    IFS='|' read -r st _ msg <"$VDIR/$i"
    if [ "$st" = FAIL ] && printf '%s' "$msg" | grep -qE "$TRANSIENT_RE"; then
      # 厂商偶发错误：用原命令重提一次再等
      VERIFY_RETRIED=$((VERIFY_RETRIED+1))
      ro=$(eval "${CMDS[$idx]}" 2>&1)
      rq=$(printf '%s' "$ro" | grep -oE 'thcli \+gen status [a-z0-9_/.-]+ [A-Za-z0-9_-]{6,}' | head -1)
      if [ -n "$rq" ]; then
        IFS='|' read -r st _ msg <<<"$(wait_one "$cid" "$(awk '{print $4}' <<<"$rq")" "$(awk '{print $5}' <<<"$rq")")"
        msg="(重提) $msg"
      fi
    fi
    if [ "$st" = DONE ]; then VERIFY_OK=$((VERIFY_OK+1)); printf '  DONE %-16s %s\n' "$cid" "$msg"
    else VERIFY_FAIL=$((VERIFY_FAIL+1)); VERIFY_FAILED+=("$cid"); printf '  FAIL %-16s %s\n' "$cid" "$msg"; fi
    i=$((i+1))
  done
fi

echo ""
echo "== 汇总（层级: $MODE）=="
echo "PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
for t in local body server real; do
  [ -n "${TIER_PASS[$t]:-}${TIER_FAIL[$t]:-}" ] && printf '  %-7s PASS=%-4s FAIL=%s\n' "$t" "${TIER_PASS[$t]:-0}" "${TIER_FAIL[$t]:-0}"
done
[ "$VERIFY" = 1 ] && echo "VERIFY  完成=$VERIFY_OK  失败=$VERIFY_FAIL  重提=$VERIFY_RETRIED${VERIFY_FAILED[*]:+  (${VERIFY_FAILED[*]})}"
[ -n "${ACT_OK:-}" ] && echo "ACT     开启(含幂等)=$ACT_OK 失败=$ACT_FAIL${ACT_FAILED[*]:+  (${ACT_FAILED[*]})}"
if [ -d "$R_OUT" ] && ls "$R_OUT"/*/ >/dev/null 2>&1; then
  echo ""
  echo "== 产物映射（$R_OUT，目录名 = 用例 ID → 产物文件）=="
  for d in "$R_OUT"/*/; do
    [ -d "$d" ] || continue
    id=$(basename "$d"); files=$(ls -1 "$d" 2>/dev/null | paste -sd' ' -)
    printf '  %-16s %s\n' "$id" "${files:-(空)}"
  done
fi
if [ "$FAIL" -gt 0 ] || [ "$VERIFY_FAIL" -gt 0 ]; then
  [ "$FAIL" -gt 0 ] && echo "失败用例: ${FAILED[*]}"
  exit 1
fi
echo "全部通过。"
