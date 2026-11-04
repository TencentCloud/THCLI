# THCLI-AIGC `+gen` / `doctor` 使用指南

适用版本：**1.0.2**（33 个生成接口：图像 6 / 视频 16 / 3D 3 / 语音音频 8）

通用约定：

- 命令前缀 `thcli`（别名 `th`）；`+gen` 走数据面（Bearer API Key），与 `+chat`/`+connect` 共用凭证。
- 数据面选项（所有提交/查询命令通用）：`--api-key <key>`（临时指定 Key）、`--alias <alias>`（选择已保存 Key，默认 `default`）、`--area <area>`（数据面地域：`gz` / `sg`，默认 `gz`）、`--verbose`（打印请求/响应日志）。
- 请求体顶层字段 = 一个 flag，flag 名 = 字段名下划线换连字符（`negative_prompt` → `--negative-prompt`）；数组传 JSON 数组、对象传 JSON 对象。
- 覆盖关系：**接口参数 < `--param` < `--body`**（`--body` 全量替换请求体）。

---

## 1. 接口发现与帮助

```bash
# 列出全部 33 个接口（接口 ID / 类别 / 模型 / 同步异步 / 参数数）
thcli +gen apis

# 查看单个接口的完整用法、路径、参数说明与模型差异
thcli +gen apis wand/kling/text-to-video

# --help 按接口输出参数详细说明（只挂该接口的字段 flag）
thcli +gen wand/kling/omni-video --help

# 不带接口的 --help 输出 +gen 总体用法
thcli +gen --help
```

---

## 2. 生成用例

### 2.1 图像（6 个接口）

```bash
# 混元生图 v3：文生图（同步，提交即返回）
thcli +gen wand/hunyuan-image/v3-generation \
  --model hy-image-v3 \
  --prompt "一只橘猫在窗台晒太阳" \
  --size 1024x1024 --seed 42 --output ./out

# 混元生图 v3：本地参考图（数组字段可直接给单个值）
thcli +gen wand/hunyuan-image/v3-generation \
  --model hy-image-v3 --images ./ref.png --prompt "换成雪景"

# 混元生图 v3.5：多轮会话编辑（Chat/Messages 协议）
thcli +gen wand/hunyuan-image/v35-generation \
  --model hy-image-v3.5-preview \
  --messages '[{"role":"user","content":[{"type":"text","text":"把背景换成星空"},{"type":"image_url","image_url":{"url":"./ref.png"}}]}]'

# Seedream：图层拆分（仅 pro / flash）
thcli +gen wand/si-image/generation \
  --model seedream-image-v5.0-pro \
  --prompt "赛博朋克城市夜景海报" \
  --size 2K --layer-decomposition true --background transparent

# Kling 生图：组图（result_type=series 仅 v3-omni）
thcli +gen wand/kling-image/generation \
  --model kling-image-v3-omni \
  --prompt "同一角色在四个季节里的肖像" \
  --image-list '["./a.png","./b.png"]' \
  --result-type series --series-amount 4

# Kling 生图：主体参考（element_id 来自 +gen resource kling-element，见 §4）
thcli +gen wand/kling-image/generation \
  --model kling-image-o1 \
  --prompt "这只小狗在草地上奔跑" \
  --element-list '[{"element_id":"el-xxxx"}]'
```

### 2.2 视频（16 个接口）

```bash
# 混元视频：文生（aspect_ratio 仅文生）
thcli +gen wand/hunyuan-video/generation \
  --model hy-video-v1.5 \
  --prompt "雨夜霓虹街道，镜头缓慢推进" \
  --aspect-ratio 16:9 --revise true

# 混元视频：图生（本地文件走 --image，公网 URL 走 --image_url，二选一）
thcli +gen wand/hunyuan-video/generation \
  --model hy-video-v1.5 --image ./first.png --prompt "画面动起来"

# Kling 文生视频：V3 多镜头语法
thcli +gen wand/kling/text-to-video \
  --model kling-video-v3 \
  --prompt "[镜头1]特写：少年握紧船舵；[镜头2]全景：帆船冲出浪头" \
  --settings '{"resolution":"1080p","duration":8,"aspect_ratio":"16:9"}'

# Kling 图生视频：首帧 + 主体 + 音色
thcli +gen wand/kling/image-to-video \
  --model kling-video-v3 \
  --contents '[{"type":"first_frame","url":"./first.png"},{"type":"prompt","text":"少女回头微笑"},{"type":"element","element_id":"el-xxxx"}]' \
  --settings '{"duration":10}'

# Kling 全能编辑（omni）：换背景（无首帧时 settings.aspect_ratio 必填）
thcli +gen wand/kling/omni-video \
  --model kling-video-v3-omni \
  --contents '[{"type":"prompt","text":"把背景换成夜景"},{"type":"base_video","url":"https://example.com/in.mp4"}]' \
  --settings '{"aspect_ratio":"16:9"}'

# Kling 动作控制：形象图 + 动作视频
thcli +gen wand/kling/motion-control \
  --model kling-video-motion-control-v3.0 \
  --contents '[{"type":"image","url":"./角色.png"},{"type":"video","url":"https://example.com/dance.mp4"},{"type":"prompt","text":"跟随视频做同样的动作"}]' \
  --settings '{"character_orientation":"image","resolution":"1080p"}'

# Vidu 首尾帧：2 张图（分辨率相近，可本地文件）
thcli +gen wand/vidu/start-end-to-video \
  --model vidu-video-q3-pro \
  --images '["./start.png","./end.png"]' \
  --prompt "从日出到星空的延时"

# Vidu 参考生视频：主体式（prompt 中 @name 引用）
thcli +gen wand/vidu/reference-to-video \
  --model vidu-video-q2-pro \
  --subjects '[{"name":"主角","images":["./正面.png","./侧面.png"]}]' \
  --prompt "@主角 站在山顶眺望云海"

# MiniMax H3：多模态素材（文生时 ratio 必填且不可 adaptive）
thcli +gen wand/minimax-video-v2/generation \
  --model minimax-video-h3 \
  --content '[{"type":"text","text":"海浪拍打礁石，慢镜头"}]' \
  --resolution 2K --duration 8 --ratio 16:9

# WAND 视频：本地图片/音频自动编码为 data URL（Unreleased 实测放宽，音频须 2~15 秒）；视频素材仅公网 URL（上游明确拒绝内联 base64）。1.0.2 及之前版本需先转公网 URL
thcli +gen wand/vega-videos/tasks \
  --model wand-vega-video-1.0-lite \
  --content '[{"type":"text","text":"猫伸懒腰"},{"type":"image_url","image_url":{"url":"./cat.jpg"},"role":"first_frame"}]'
```

### 2.3 3D 与世界模型（3 个接口）

```bash
# 混元 3D：图生 3D（本地文件走 --image-base64；result_format 服务端只认大写）
thcli +gen api/3d/submit \
  --model hy-3d-3.0 \
  --image-base64 ./toy.png \
  --enable-pbr true --result-format GLB --output ./out

# 世界模型 360° 全景（同步）
thcli +gen wand/hunyuan-image/world2-panorama \
  --model hy-world2-panorama \
  --prompt "黄昏的海边小镇，街道两旁是咖啡馆"

# 世界模型交互式 3D 场景（异步；prompt 与 image_url 二选一）
thcli +gen wand/hunyuan-video/world2-scene \
  --model hy-world2-scene \
  --prompt "一座可以漫游的江南园林"
```

### 2.4 语音与音乐（8 个接口）

```bash
# 语音识别·同步直转：本地音频走 --data（与 --input-url 二选一）
thcli +gen wand/asrproxy/sync_transcribe \
  --model hy-asr-3.0-preview \
  --data ./meeting.mp3 --source zh

# 语音识别·异步转写：仅公网 URL（≤10h / 10GB），出 SRT/VTT 字幕
thcli +gen wand/asrproxy/async_create \
  --model wand-asr-v1 \
  --input-url https://example.com/2h.mp4 \
  --subtitle-format srt --output ./out

# 语音合成 TTS（同步；voice_setting.voice_id 必填）
thcli +gen wand/minimax-tts/sync_tts \
  --model minimax-speech-2.6-hd \
  --text "欢迎使用腾讯云大模型服务平台。" \
  --voice-setting '{"voice_id":"male-qn-qingse","speed":1.2}' \
  --audio-setting '{"format":"mp3","sample_rate":32000}' \
  --subtitle-enable true --output ./out

# 声音克隆（同步）：--audio-url 与 --audio-data 二选一，返回可复用的 voice_id
thcli +gen wand/minimax-tts/sync_clone \
  --model minimax-voice-clone \
  --audio-data ./sample.mp3 --text "克隆成功后我会说这段话"

# 声音设计（同步）：自然语言描述音色 → voice_id + 试听
thcli +gen wand/minimax-tts/sync_design \
  --model minimax-voice-design \
  --prompt "沉稳的男声，纪录片旁白风格" \
  --preview-text "这是试听文本"

# AI 配音（异步）：本地视频 ≤75MB / URL ≤1GB
thcli +gen wand/dubbing/async_generation \
  --model wand-dubbing-clone-v2 \
  --input-url ./promo.mp4 --src-language zh --dst-language en

# MiniMax 音乐：纯音乐
thcli +gen wand/minimax-music/generation \
  --model minimax-music-v3.0 \
  --prompt "轻快的钢琴曲，适合早晨" --is-instrumental true --output ./out

# MiniMax 音乐：按提示词自动写词成曲
thcli +gen wand/minimax-music/generation \
  --model minimax-music-v3.0 \
  --prompt "夏日情歌，吉他伴奏" --lyrics-optimizer true

# Mureka 歌词成曲（当前仅歌词成曲，--lyrics 必填）
thcli +gen wand/mureka-music/generation \
  --model mureka-music-v9 \
  --lyrics $'[Verse]\n夏天的风\n[Chorus]\n吹过海边' \
  --prompt "pop, emotional, female vocal" --n 1
```

---

## 3. 异步任务管理

```bash
# 列出近期任务（gen-tasks 缓存；--all 跨别名，--no-refresh 不刷新）
thcli +gen tasks --limit 20
thcli +gen tasks --all

# 查询任务状态（只查不提交）
thcli +gen status wand/kling/text-to-video <task-id> --model kling-video-v3

# 等到出结果并落盘（--wait 轮询至终态，--result 下载结果文件到 --output）
thcli +gen status wand/kling/text-to-video <task-id> \
  --model kling-video-v3 --wait --result --output ./out

# 提交后不等结果（--no-wait 只报任务 ID，稍后用 status 查）
thcli +gen wand/hunyuan-video/generation \
  --model hy-video-v1.5 --prompt "..." --no-wait
```

轮询类选项：`--timeout <sec>`（默认 1800，异步时为轮询总超时）、`--interval <sec>`（默认 5）、`--retry <n>`。

---

## 4. Kling 资源管理（主体 / 音色）

```bash
# 创建主体：至少 2 张参考图（1 正面 + 1~3 其他角度，单张会被上游拒），可加动作参考视频
thcli +gen resource kling-element create \
  --images ./正面.png --images ./侧面.png \
  --ref-video https://example.com/动作.mp4

# 查询创建任务（resource 任务不入 gen-tasks，可随时查）
thcli +gen resource kling-element get --task-id <task-id>

# 删除主体
thcli +gen resource kling-element delete --element-id <element-id>

# 创建音色：--input 本地音频或 URL
thcli +gen resource kling-voice create \
  --input ./sample.wav --text "克隆音色的试听文本"

# 查询 / 删除音色
thcli +gen resource kling-voice get --task-id <task-id>
thcli +gen resource kling-voice delete --voice-id <voice-id>
```

产出的 `element_id` / `voice_id` 可在生成命令里引用：`--element-list`（Kling 生图）、`contents` 里的 `{"type":"element","element_id":…}`（Kling 视频）。

---

## 5. 参数覆盖与调试

```bash
# --param：点路径覆盖单个字段；= 值为字符串，:= 值按 JSON 解析
thcli +gen wand/kling/text-to-video \
  --model kling-video-v3 --prompt "..." \
  --param settings.duration:=5 \
  --param settings.resolution='"1080p"'

# --body：整份请求体全量替换（可 @文件）
thcli +gen wand/vidu/text-to-video --body @body.json

# --dry-run：只打印最终请求体，不发送
thcli +gen wand/minimax-tts/sync_tts \
  --model minimax-speech-2.6-hd \
  --text "..." --voice-setting '{"voice_id":"male-qn-qingse"}' \
  --dry-run

# --verbose：打印请求/响应日志
thcli +gen wand/kling-image/generation \
  --model kling-image-v3 --prompt "..." --verbose
```

---

## 6. doctor 与 `+gen` 的联动

```bash
# 整体健康检查（默认命令）
thcli doctor all

# 模型诊断：是否存在 / 接入点是否可用；
# 若是 +gen 模型，追加按量调用诊断（后付费 / 本地按量 Key / 推荐的 +gen 写法）
thcli doctor model --id kling-video-v3 --region ap-guangzhou

# 地域对应关系：--region ap-guangzhou ↔ +gen --area gz；ap-singapore ↔ --area sg
# 用 +gen --area sg 调用的模型，诊断时传 --region ap-singapore
thcli doctor model --id vidu-video-q3-pro --region ap-singapore

# 厂商错误码解释（生成失败时，错误信息尾部的 (code) 拿来查）
thcli doctor error 401007 --vendor kling
thcli doctor error 1201 --vendor kling
```

排障套路：生成失败 → 看错误信息末尾的 `(code)` → `thcli doctor error <code> --vendor <厂商>` 查含义；调不通 → `thcli doctor model --id <模型>` 看按量路由；整体异常 → `thcli doctor all`。

---

## 7. 后续版本预告

以下能力已开发，将随下个版本发布（届时接口数 33 → 36）：

- Mureka 提示词成曲 / 纯音乐开关
- 天籁 31 方言长音频异步转写
- TTS SSE 流式合成
