# +gen 用例目录

> 由 `test/gen/generate.ts` 按接口注册表生成，勿手改；参数 = 官方接口请求体字段，flag 名即字段名（下划线换连字符）。
> 数组传 JSON 数组（字符串数组也可直接给单个值），对象传 JSON 对象；素材全部来自 `test/assets`：`../assets/...` 为本地文件（自动编码），`https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/...` 为同一素材的公网副本（只收 URL 的字段用）。

| 类别 | 接口数 | 用例数 |
|---|---|---|
| [图像](#图像) | 8 | 69 |
| [视频](#视频) | 16 | 155 |
| [3D](#3d) | 3 | 25 |
| [语音](#语音) | 11 | 69 |
| **合计** | **38** | **318** |

## 图像

| 接口 | 模型 | 字段（* 必填） | 用例数 |
|---|---|---|---|
| [wand/hunyuan-image/v3-generation](#wandhunyuan-imagev3-generation) | hy-image-v3 | *--prompt --images --size --seed --footnote --revise | 7 |
| [wand/hunyuan-image/v35-generation](#wandhunyuan-imagev35-generation) | hy-image-v3.5-preview | *--messages --size --seed --generate-max-pixels --resize-max-pixels --session --footnote --use-search-tool | 9 |
| [wand/si-image/generation](#wandsi-imagegeneration) | seedream-image-v5.0-pro / seedream-image-v5.0-lite / seedream-image-v5.0-flash | *--prompt --images --size --layer-decomposition --optimize-prompt-options --output-format --background --response-format --sequential-image-generation --sequential-image-generation-options --tools --watermark | 18 |
| [wand/vega-images/generations](#wandvega-imagesgenerations) | wand-vega-image-lite / wand-vega-image-flash / wand-vega-image-pro / wand-vega-image-1.5-pro | *--prompt --input --size | 4 |
| [wand/vidu-image/generation](#wandvidu-imagegeneration) | vidu-image-q2 | *--prompt --images --aspect-ratio --resolution --seed --callback-url | 7 |
| [wand/kling-image/generation](#wandkling-imagegeneration) | kling-image-v3 / kling-image-o1 / kling-image-v3-omni | *--prompt --negative-prompt --image --image-list --element-list --aspect-ratio --resolution --n --watermark-info --result-type --series-amount | 17 |
| [wand/hidream-image/images/generations](#wandhidream-imageimagesgenerations) | hidream-image-o1-1.5 | *--prompt --size | 3 |
| [wand/hidream-image/images/edits](#wandhidream-imageimagesedits) | hidream-image-o1-1.5-edit | *--prompt *--images --size | 4 |

### wand/hunyuan-image/v3-generation

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| img-hunyuan-image-v3-generation-01 | 最小调用 | `thcli +gen wand/hunyuan-image/v3-generation --prompt 猫` | 必填字段 | 请求体含全部必填字段 |
| img-hunyuan-image-v3-generation-02 | --images | `thcli +gen wand/hunyuan-image/v3-generation --prompt 猫 --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]'` | images | 请求体含 images |
| img-hunyuan-image-v3-generation-03 | --size | `thcli +gen wand/hunyuan-image/v3-generation --prompt 猫 --size 1024x1024` | size | 请求体含 size |
| img-hunyuan-image-v3-generation-04 | --seed | `thcli +gen wand/hunyuan-image/v3-generation --prompt 猫 --seed 42` | seed | 请求体含 seed |
| img-hunyuan-image-v3-generation-05 | --footnote | `thcli +gen wand/hunyuan-image/v3-generation --prompt 猫 --footnote 水印` | footnote | 请求体含 footnote |
| img-hunyuan-image-v3-generation-06 | --revise | `thcli +gen wand/hunyuan-image/v3-generation --prompt 猫 --revise true` | revise | 请求体含 revise |
| img-hunyuan-image-v3-generation-07 | 缺 --prompt | `thcli +gen wand/hunyuan-image/v3-generation` | 必填校验 | 本地报「--prompt 必填」 |

### wand/hunyuan-image/v35-generation

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| img-hunyuan-image-v35-generation-01 | 最小调用 | `thcli +gen wand/hunyuan-image/v35-generation --messages '[{"role":"user","content":[{"type":"text","text":"猫"}]}]'` | 必填字段 | 请求体含全部必填字段 |
| img-hunyuan-image-v35-generation-02 | --size | `thcli +gen wand/hunyuan-image/v35-generation --messages '[{"role":"user","content":[{"type":"text","text":"猫"}]}]' --size 1024x1024` | size | 请求体含 size |
| img-hunyuan-image-v35-generation-03 | --seed | `thcli +gen wand/hunyuan-image/v35-generation --messages '[{"role":"user","content":[{"type":"text","text":"猫"}]}]' --seed 42` | seed | 请求体含 seed |
| img-hunyuan-image-v35-generation-04 | --generate-max-pixels | `thcli +gen wand/hunyuan-image/v35-generation --messages '[{"role":"user","content":[{"type":"text","text":"猫"}]}]' --generate-max-pixels 1` | generate_max_pixels | 请求体含 generate_max_pixels |
| img-hunyuan-image-v35-generation-05 | --resize-max-pixels | `thcli +gen wand/hunyuan-image/v35-generation --messages '[{"role":"user","content":[{"type":"text","text":"猫"}]}]' --resize-max-pixels 1` | resize_max_pixels | 请求体含 resize_max_pixels |
| img-hunyuan-image-v35-generation-06 | --session | `thcli +gen wand/hunyuan-image/v35-generation --messages '[{"role":"user","content":[{"type":"text","text":"猫"}]}]' --session sess-001` | session | 请求体含 session |
| img-hunyuan-image-v35-generation-07 | --footnote | `thcli +gen wand/hunyuan-image/v35-generation --messages '[{"role":"user","content":[{"type":"text","text":"猫"}]}]' --footnote 水印` | footnote | 请求体含 footnote |
| img-hunyuan-image-v35-generation-08 | --use-search-tool | `thcli +gen wand/hunyuan-image/v35-generation --messages '[{"role":"user","content":[{"type":"text","text":"猫"}]}]' --use-search-tool '{"value":true}'` | use_search_tool | 请求体含 use_search_tool |
| img-hunyuan-image-v35-generation-09 | 缺 --messages | `thcli +gen wand/hunyuan-image/v35-generation` | 必填校验 | 本地报「--messages 必填」 |

### wand/si-image/generation

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| img-si-image-generation-01 | 最小调用 | `thcli +gen wand/si-image/generation --model seedream-image-v5.0-pro --prompt 猫` | 必填字段 | 请求体含全部必填字段 |
| img-si-image-generation-02 | --images | `thcli +gen wand/si-image/generation --model seedream-image-v5.0-pro --prompt 猫 --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]'` | images | 请求体含 images |
| img-si-image-generation-03 | --size | `thcli +gen wand/si-image/generation --model seedream-image-v5.0-pro --prompt 猫 --size 1024x1024` | size | 请求体含 size |
| img-si-image-generation-04 | --layer-decomposition | `thcli +gen wand/si-image/generation --model seedream-image-v5.0-pro --prompt 猫 --layer-decomposition true` | layer_decomposition | 请求体含 layer_decomposition |
| img-si-image-generation-05 | --optimize-prompt-options | `thcli +gen wand/si-image/generation --model seedream-image-v5.0-pro --prompt 猫 --optimize-prompt-options '{"mode":"standard"}'` | optimize_prompt_options | 请求体含 optimize_prompt_options |
| img-si-image-generation-06 | --output-format | `thcli +gen wand/si-image/generation --model seedream-image-v5.0-pro --prompt 猫 --output-format png` | output_format | 请求体含 output_format |
| img-si-image-generation-07 | --background | `thcli +gen wand/si-image/generation --model seedream-image-v5.0-pro --prompt 猫 --background transparent` | background | 请求体含 background |
| img-si-image-generation-08 | --response-format | `thcli +gen wand/si-image/generation --model seedream-image-v5.0-pro --prompt 猫 --response-format url` | response_format | 请求体含 response_format |
| img-si-image-generation-09 | --sequential-image-generation | `thcli +gen wand/si-image/generation --model seedream-image-v5.0-lite --prompt 猫 --sequential-image-generation auto` | sequential_image_generation | 请求体含 sequential_image_generation |
| img-si-image-generation-10 | --sequential-image-generation-options | `thcli +gen wand/si-image/generation --model seedream-image-v5.0-lite --prompt 猫 --sequential-image-generation-options '{"max_images":1}'` | sequential_image_generation_options | 请求体含 sequential_image_generation_options |
| img-si-image-generation-11 | --tools | `thcli +gen wand/si-image/generation --model seedream-image-v5.0-lite --prompt 猫 --tools '{"type":"web_search"}'` | tools | 请求体含 tools |
| img-si-image-generation-12 | --watermark | `thcli +gen wand/si-image/generation --model seedream-image-v5.0-pro --prompt 猫 --watermark true` | watermark | 请求体含 watermark |
| img-si-image-generation-13 | 缺 --prompt | `thcli +gen wand/si-image/generation --model seedream-image-v5.0-pro` | 必填校验 | 本地报「--prompt 必填」 |
| img-si-image-generation-14 | seedream-image-v5.0-lite 传 --layer-decomposition | `thcli +gen wand/si-image/generation --model seedream-image-v5.0-lite --prompt 猫 --layer-decomposition true` | 适用模型 | 本地报「仅 seedream-image-v5.0-pro / seedream-image-v5.0-flash 支持」 |
| img-si-image-generation-15 | seedream-image-v5.0-lite 传 --background | `thcli +gen wand/si-image/generation --model seedream-image-v5.0-lite --prompt 猫 --background transparent` | 适用模型 | 本地报「仅 seedream-image-v5.0-pro / seedream-image-v5.0-flash 支持」 |
| img-si-image-generation-16 | seedream-image-v5.0-pro 传 --sequential-image-generation | `thcli +gen wand/si-image/generation --model seedream-image-v5.0-pro --prompt 猫 --sequential-image-generation auto` | 适用模型 | 本地报「仅 seedream-image-v5.0-lite 支持」 |
| img-si-image-generation-17 | seedream-image-v5.0-pro 传 --sequential-image-generation-options | `thcli +gen wand/si-image/generation --model seedream-image-v5.0-pro --prompt 猫 --sequential-image-generation-options '{"max_images":1}'` | 适用模型 | 本地报「仅 seedream-image-v5.0-lite 支持」 |
| img-si-image-generation-18 | seedream-image-v5.0-pro 传 --tools | `thcli +gen wand/si-image/generation --model seedream-image-v5.0-pro --prompt 猫 --tools '{"type":"web_search"}'` | 适用模型 | 本地报「仅 seedream-image-v5.0-lite 支持」 |

### wand/vega-images/generations

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| img-vega-images-generations-01 | 最小调用 | `thcli +gen wand/vega-images/generations --model wand-vega-image-lite --prompt 猫` | 必填字段 | 请求体含全部必填字段 |
| img-vega-images-generations-02 | --input | `thcli +gen wand/vega-images/generations --model wand-vega-image-lite --prompt 猫 --input '[{"content":[{"type":"input_image"}]}]'` | input | 请求体含 input |
| img-vega-images-generations-03 | --size | `thcli +gen wand/vega-images/generations --model wand-vega-image-lite --prompt 猫 --size 1024x1024` | size | 请求体含 size |
| img-vega-images-generations-04 | 缺 --prompt | `thcli +gen wand/vega-images/generations --model wand-vega-image-lite` | 必填校验 | 本地报「--prompt 必填」 |

### wand/vidu-image/generation

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| img-vidu-image-generation-01 | 最小调用 | `thcli +gen wand/vidu-image/generation --prompt 猫` | 必填字段 | 请求体含全部必填字段 |
| img-vidu-image-generation-02 | --images | `thcli +gen wand/vidu-image/generation --prompt 猫 --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]'` | images | 请求体含 images |
| img-vidu-image-generation-03 | --aspect-ratio | `thcli +gen wand/vidu-image/generation --prompt 猫 --aspect-ratio 16:9` | aspect_ratio | 请求体含 aspect_ratio |
| img-vidu-image-generation-04 | --resolution | `thcli +gen wand/vidu-image/generation --prompt 猫 --resolution 1080p` | resolution | 请求体含 resolution |
| img-vidu-image-generation-05 | --seed | `thcli +gen wand/vidu-image/generation --prompt 猫 --seed 42` | seed | 请求体含 seed |
| img-vidu-image-generation-06 | --callback-url | `thcli +gen wand/vidu-image/generation --prompt 猫 --callback-url https://example.com/cb` | callback_url | 请求体含 callback_url |
| img-vidu-image-generation-07 | 缺 --prompt | `thcli +gen wand/vidu-image/generation` | 必填校验 | 本地报「--prompt 必填」 |

### wand/kling-image/generation

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| img-kling-image-generation-01 | 最小调用 | `thcli +gen wand/kling-image/generation --model kling-image-v3 --prompt 猫` | 必填字段 | 请求体含全部必填字段 |
| img-kling-image-generation-02 | --negative-prompt | `thcli +gen wand/kling-image/generation --model kling-image-v3 --prompt 猫 --negative-prompt x` | negative_prompt | 请求体含 negative_prompt |
| img-kling-image-generation-03 | --image | `thcli +gen wand/kling-image/generation --model kling-image-v3 --prompt 猫 --image ../assets/images/cat-window.jpg` | image | 请求体含 image |
| img-kling-image-generation-04 | --image-list | `thcli +gen wand/kling-image/generation --model kling-image-o1 --prompt 猫 --image-list '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]'` | image_list | 请求体含 image_list |
| img-kling-image-generation-05 | --element-list | `thcli +gen wand/kling-image/generation --model kling-image-v3 --prompt 猫 --element-list '[{"element_id":"x"}]'` | element_list | 请求体含 element_list |
| img-kling-image-generation-06 | --aspect-ratio | `thcli +gen wand/kling-image/generation --model kling-image-v3 --prompt 猫 --aspect-ratio 16:9` | aspect_ratio | 请求体含 aspect_ratio |
| img-kling-image-generation-07 | --resolution | `thcli +gen wand/kling-image/generation --model kling-image-v3 --prompt 猫 --resolution 1k` | resolution | 请求体含 resolution |
| img-kling-image-generation-08 | --n | `thcli +gen wand/kling-image/generation --model kling-image-v3 --prompt 猫 --n 2` | n | 请求体含 n |
| img-kling-image-generation-09 | --watermark-info | `thcli +gen wand/kling-image/generation --model kling-image-v3 --prompt 猫 --watermark-info '{"enabled":true}'` | watermark_info | 请求体含 watermark_info |
| img-kling-image-generation-10 | --result-type | `thcli +gen wand/kling-image/generation --model kling-image-o1 --prompt 猫 --result-type single` | result_type | 请求体含 result_type |
| img-kling-image-generation-11 | --series-amount | `thcli +gen wand/kling-image/generation --model kling-image-v3-omni --prompt 猫 --series-amount 4` | series_amount | 请求体含 series_amount |
| img-kling-image-generation-12 | 缺 --prompt | `thcli +gen wand/kling-image/generation --model kling-image-v3` | 必填校验 | 本地报「--prompt 必填」 |
| img-kling-image-generation-13 | kling-image-o1 传 --negative-prompt | `thcli +gen wand/kling-image/generation --model kling-image-o1 --prompt 猫 --negative-prompt x` | 适用模型 | 本地报「仅 kling-image-v3 支持」 |
| img-kling-image-generation-14 | kling-image-o1 传 --image | `thcli +gen wand/kling-image/generation --model kling-image-o1 --prompt 猫 --image ../assets/images/cat-window.jpg` | 适用模型 | 本地报「仅 kling-image-v3 支持」 |
| img-kling-image-generation-15 | kling-image-v3 传 --image-list | `thcli +gen wand/kling-image/generation --model kling-image-v3 --prompt 猫 --image-list '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]'` | 适用模型 | 本地报「仅 kling-image-o1 / kling-image-v3-omni 支持」 |
| img-kling-image-generation-16 | kling-image-v3 传 --result-type | `thcli +gen wand/kling-image/generation --model kling-image-v3 --prompt 猫 --result-type single` | 适用模型 | 本地报「仅 kling-image-o1 / kling-image-v3-omni 支持」 |
| img-kling-image-generation-17 | kling-image-v3 传 --series-amount | `thcli +gen wand/kling-image/generation --model kling-image-v3 --prompt 猫 --series-amount 4` | 适用模型 | 本地报「仅 kling-image-v3-omni 支持」 |

### wand/hidream-image/images/generations

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| img-hidream-image-images-generations-01 | 最小调用 | `thcli +gen wand/hidream-image/images/generations --prompt 猫` | 必填字段 | 请求体含全部必填字段 |
| img-hidream-image-images-generations-02 | --size | `thcli +gen wand/hidream-image/images/generations --prompt 猫 --size 2048x2048` | size | 请求体含 size |
| img-hidream-image-images-generations-03 | 缺 --prompt | `thcli +gen wand/hidream-image/images/generations` | 必填校验 | 本地报「--prompt 必填」 |

### wand/hidream-image/images/edits

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| img-hidream-image-images-edits-01 | 最小调用 | `thcli +gen wand/hidream-image/images/edits --prompt 猫 --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]'` | 必填字段 | 请求体含全部必填字段 |
| img-hidream-image-images-edits-02 | --size | `thcli +gen wand/hidream-image/images/edits --prompt 猫 --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --size 2048x2048` | size | 请求体含 size |
| img-hidream-image-images-edits-03 | 缺 --prompt | `thcli +gen wand/hidream-image/images/edits --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]'` | 必填校验 | 本地报「--prompt 必填」 |
| img-hidream-image-images-edits-04 | 缺 --images | `thcli +gen wand/hidream-image/images/edits --prompt 猫` | 必填校验 | 本地报「--images 必填」 |

## 视频

| 接口 | 模型 | 字段（* 必填） | 用例数 |
|---|---|---|---|
| [wand/hunyuan-video/generation](#wandhunyuan-videogeneration) | hy-video-v1.5 | --prompt --negative-prompt --image --image-url --n --duration --aspect-ratio --resolution --revise --moderation --seed --footnote | 14 |
| [wand/kling/text-to-video](#wandklingtext-to-video) | kling-video-v4 / kling-video-v3 / kling-video-v3-turbo / kling-video-v2.6 / kling-video-v2.5-turbo | *--prompt --settings --options | 4 |
| [wand/kling/image-to-video](#wandklingimage-to-video) | kling-video-v4 / kling-video-v3 / kling-video-v3-turbo / kling-video-v2.6 / kling-video-v2.5-turbo | *--contents --settings --options | 4 |
| [wand/kling/omni-video](#wandklingomni-video) | kling-video-v4 / kling-video-v3-omni / kling-video-o1 | *--contents --settings --options | 4 |
| [wand/kling/motion-control](#wandklingmotion-control) | kling-video-motion-control-v3.0 / kling-video-motion-control-v2.6 | *--contents *--settings --options | 4 |
| [wand/vidu/text-to-video](#wandvidutext-to-video) | vidu-video-q3-turbo / vidu-video-q3-pro / vidu-video-q2 | *--prompt --style --duration --aspect-ratio --resolution --movement-amplitude --bgm --audio --audio-type --seed --payload --watermark --wm-position --wm-url | 15 |
| [wand/vidu/image-to-video](#wandviduimage-to-video) | vidu-video-q4-preview / vidu-video-q3-turbo / vidu-video-q3-pro / vidu-video-q3 / vidu-video-q2 / vidu-video-q2-pro / vidu-video-q2-turbo | *--images --prompt --audio --audio-type --voice-id --is-rec --bgm --duration --resolution --movement-amplitude --seed --payload --watermark --wm-position --wm-url | 16 |
| [wand/vidu/start-end-to-video](#wandvidustart-end-to-video) | vidu-video-q3-turbo / vidu-video-q3-pro / vidu-video-q3 / vidu-video-q2 / vidu-video-q2-pro / vidu-video-q2-turbo | *--images --prompt --is-rec --duration --resolution --movement-amplitude --audio --bgm --seed --payload --watermark --wm-position --wm-url | 14 |
| [wand/vidu/reference-to-video](#wandvidureference-to-video) | vidu-video-q4-preview / vidu-video-q3-turbo / vidu-video-q3 / vidu-video-q2 / vidu-video-q2-pro / vidu-video-q2-turbo | --subjects --images --videos *--prompt --auto-subjects --audio --audio-type --duration --aspect-ratio --resolution --movement-amplitude --bgm --seed --payload --watermark --wm-position --wm-url | 19 |
| [wand/pixverse/text-to-video](#wandpixversetext-to-video) | pixverse-video-v6.0 / pixverse-video-c1 / pixverse-video-v5.6 | *--prompt *--duration *--quality --aspect-ratio --camera-movement --seed --generate-audio-switch --generate-multi-clip-switch | 10 |
| [wand/pixverse/image-to-video](#wandpixverseimage-to-video) | pixverse-video-v6.0 / pixverse-video-c1 / pixverse-video-v5.6 | *--img-id --img-ids *--prompt *--duration *--quality --camera-movement --seed --generate-audio-switch --generate-multi-clip-switch | 12 |
| [wand/pixverse/start-end-to-video](#wandpixversestart-end-to-video) | pixverse-video-v6.0 / pixverse-video-c1 / pixverse-video-v5.6 | *--prompt *--first-frame-img *--last-frame-img *--duration *--quality --seed --generate-audio-switch | 8 |
| [wand/pixverse/reference-to-video](#wandpixversereference-to-video) | pixverse-video-v6.0 / pixverse-video-c1 / pixverse-video-v5.6 | *--image-references *--prompt *--duration *--quality --aspect-ratio --generate-audio-switch --seed | 8 |
| [wand/minimax-video/generation](#wandminimax-videogeneration) | minimax-video-v2.3 / minimax-video-v2.3-fast | --prompt --prompt-optimizer --fast-pretreatment --duration --resolution --aigc-watermark --first-frame-image --last-frame-image | 10 |
| [wand/minimax-video-v2/generation](#wandminimax-video-v2generation) | minimax-video-h3 / minimax-video-h3-max | *--content *--resolution *--duration --ratio --aigc-watermark --extra | 7 |
| [wand/vega-videos/tasks](#wandvega-videostasks) | wand-vega-video-1.0-lite | *--content --resolution --ratio --duration --options | 6 |

### wand/hunyuan-video/generation

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| vid-hunyuan-video-generation-01 | 最小调用 | `thcli +gen wand/hunyuan-video/generation --prompt 猫` | 必填字段 | 请求体含全部必填字段 |
| vid-hunyuan-video-generation-02 | --prompt | `thcli +gen wand/hunyuan-video/generation --prompt 猫` | prompt | 请求体含 prompt |
| vid-hunyuan-video-generation-03 | --negative-prompt | `thcli +gen wand/hunyuan-video/generation --prompt 猫 --negative-prompt x` | negative_prompt | 请求体含 negative_prompt |
| vid-hunyuan-video-generation-04 | --image | `thcli +gen wand/hunyuan-video/generation --image ../assets/images/cat-window.jpg` | image | 请求体含 image |
| vid-hunyuan-video-generation-05 | --image-url | `thcli +gen wand/hunyuan-video/generation --image-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg` | image_url | 请求体含 image_url |
| vid-hunyuan-video-generation-06 | --n | `thcli +gen wand/hunyuan-video/generation --prompt 猫 --n 2` | n | 请求体含 n |
| vid-hunyuan-video-generation-07 | --duration | `thcli +gen wand/hunyuan-video/generation --prompt 猫 --duration 5` | duration | 请求体含 duration |
| vid-hunyuan-video-generation-08 | --aspect-ratio | `thcli +gen wand/hunyuan-video/generation --prompt 猫 --aspect-ratio 16:9` | aspect_ratio | 请求体含 aspect_ratio |
| vid-hunyuan-video-generation-09 | --resolution | `thcli +gen wand/hunyuan-video/generation --prompt 猫 --resolution x` | resolution | 请求体含 resolution |
| vid-hunyuan-video-generation-10 | --revise | `thcli +gen wand/hunyuan-video/generation --prompt 猫 --revise true` | revise | 请求体含 revise |
| vid-hunyuan-video-generation-11 | --moderation | `thcli +gen wand/hunyuan-video/generation --prompt 猫 --moderation true` | moderation | 请求体含 moderation |
| vid-hunyuan-video-generation-12 | --seed | `thcli +gen wand/hunyuan-video/generation --prompt 猫 --seed 42` | seed | 请求体含 seed |
| vid-hunyuan-video-generation-13 | --footnote | `thcli +gen wand/hunyuan-video/generation --prompt 猫 --footnote 水印` | footnote | 请求体含 footnote |
| vid-hunyuan-video-generation-14 | --image-url 本地文件 | `thcli +gen wand/hunyuan-video/generation --image-url ../assets/images/cat-window.jpg` | 只收 URL | 本地报「只收公网 URL」 |

### wand/kling/text-to-video

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| vid-kling-text-to-video-01 | 最小调用 | `thcli +gen wand/kling/text-to-video --model kling-video-v4 --prompt 猫` | 必填字段 | 请求体含全部必填字段 |
| vid-kling-text-to-video-02 | --settings | `thcli +gen wand/kling/text-to-video --model kling-video-v4 --prompt 猫 --settings '{"resolution":"720p"}'` | settings | 请求体含 settings |
| vid-kling-text-to-video-03 | --options | `thcli +gen wand/kling/text-to-video --model kling-video-v4 --prompt 猫 --options '{"external_task_id":"x"}'` | options | 请求体含 options |
| vid-kling-text-to-video-04 | 缺 --prompt | `thcli +gen wand/kling/text-to-video --model kling-video-v4` | 必填校验 | 本地报「--prompt 必填」 |

### wand/kling/image-to-video

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| vid-kling-image-to-video-01 | 最小调用 | `thcli +gen wand/kling/image-to-video --model kling-video-v4 --contents '[{"type":"prompt","text":"猫转头"},{"type":"first_frame","url":"../assets/images/cat-window.jpg"}]'` | 必填字段 | 请求体含全部必填字段 |
| vid-kling-image-to-video-02 | --settings | `thcli +gen wand/kling/image-to-video --model kling-video-v4 --contents '[{"type":"prompt","text":"猫转头"},{"type":"first_frame","url":"../assets/images/cat-window.jpg"}]' --settings '{"resolution":"720p"}'` | settings | 请求体含 settings |
| vid-kling-image-to-video-03 | --options | `thcli +gen wand/kling/image-to-video --model kling-video-v4 --contents '[{"type":"prompt","text":"猫转头"},{"type":"first_frame","url":"../assets/images/cat-window.jpg"}]' --options '{"external_task_id":"x"}'` | options | 请求体含 options |
| vid-kling-image-to-video-04 | 缺 --contents | `thcli +gen wand/kling/image-to-video --model kling-video-v4` | 必填校验 | 本地报「--contents 必填」 |

### wand/kling/omni-video

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| vid-kling-omni-video-01 | 最小调用 | `thcli +gen wand/kling/omni-video --model kling-video-v4 --contents '[{"type":"prompt","text":"猫转头"},{"type":"first_frame","url":"../assets/images/cat-window.jpg"}]'` | 必填字段 | 请求体含全部必填字段 |
| vid-kling-omni-video-02 | --settings | `thcli +gen wand/kling/omni-video --model kling-video-v4 --contents '[{"type":"prompt","text":"猫转头"},{"type":"first_frame","url":"../assets/images/cat-window.jpg"}]' --settings '{"resolution":"720p"}'` | settings | 请求体含 settings |
| vid-kling-omni-video-03 | --options | `thcli +gen wand/kling/omni-video --model kling-video-v4 --contents '[{"type":"prompt","text":"猫转头"},{"type":"first_frame","url":"../assets/images/cat-window.jpg"}]' --options '{"external_task_id":"x"}'` | options | 请求体含 options |
| vid-kling-omni-video-04 | 缺 --contents | `thcli +gen wand/kling/omni-video --model kling-video-v4` | 必填校验 | 本地报「--contents 必填」 |

### wand/kling/motion-control

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| vid-kling-motion-control-01 | 最小调用 | `thcli +gen wand/kling/motion-control --model kling-video-motion-control-v3.0 --contents '[{"type":"image","url":"https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/portrait.jpg"},{"type":"video","url":"https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/videos/dance-8s.mp4"}]' --settings '{"character_orientation":"image"}'` | 必填字段 | 请求体含全部必填字段 |
| vid-kling-motion-control-02 | --options | `thcli +gen wand/kling/motion-control --model kling-video-motion-control-v3.0 --contents '[{"type":"image","url":"https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/portrait.jpg"},{"type":"video","url":"https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/videos/dance-8s.mp4"}]' --settings '{"character_orientation":"image"}' --options '{"external_task_id":"x"}'` | options | 请求体含 options |
| vid-kling-motion-control-03 | 缺 --contents | `thcli +gen wand/kling/motion-control --model kling-video-motion-control-v3.0 --settings '{"character_orientation":"image"}'` | 必填校验 | 本地报「--contents 必填」 |
| vid-kling-motion-control-04 | 缺 --settings | `thcli +gen wand/kling/motion-control --model kling-video-motion-control-v3.0 --contents '[{"type":"image","url":"https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/portrait.jpg"},{"type":"video","url":"https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/videos/dance-8s.mp4"}]'` | 必填校验 | 本地报「--settings 必填」 |

### wand/vidu/text-to-video

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| vid-vidu-text-to-video-01 | 最小调用 | `thcli +gen wand/vidu/text-to-video --model vidu-video-q3-turbo --prompt 猫` | 必填字段 | 请求体含全部必填字段 |
| vid-vidu-text-to-video-02 | --style | `thcli +gen wand/vidu/text-to-video --model vidu-video-q3-turbo --prompt 猫 --style general` | style | 请求体含 style |
| vid-vidu-text-to-video-03 | --duration | `thcli +gen wand/vidu/text-to-video --model vidu-video-q3-turbo --prompt 猫 --duration 5` | duration | 请求体含 duration |
| vid-vidu-text-to-video-04 | --aspect-ratio | `thcli +gen wand/vidu/text-to-video --model vidu-video-q3-turbo --prompt 猫 --aspect-ratio 16:9` | aspect_ratio | 请求体含 aspect_ratio |
| vid-vidu-text-to-video-05 | --resolution | `thcli +gen wand/vidu/text-to-video --model vidu-video-q3-turbo --prompt 猫 --resolution 540p` | resolution | 请求体含 resolution |
| vid-vidu-text-to-video-06 | --movement-amplitude | `thcli +gen wand/vidu/text-to-video --model vidu-video-q3-turbo --prompt 猫 --movement-amplitude auto` | movement_amplitude | 请求体含 movement_amplitude |
| vid-vidu-text-to-video-07 | --bgm | `thcli +gen wand/vidu/text-to-video --model vidu-video-q3-turbo --prompt 猫 --bgm true` | bgm | 请求体含 bgm |
| vid-vidu-text-to-video-08 | --audio | `thcli +gen wand/vidu/text-to-video --model vidu-video-q3-turbo --prompt 猫 --audio true` | audio | 请求体含 audio |
| vid-vidu-text-to-video-09 | --audio-type | `thcli +gen wand/vidu/text-to-video --model vidu-video-q3-turbo --prompt 猫 --audio-type all` | audio_type | 请求体含 audio_type |
| vid-vidu-text-to-video-10 | --seed | `thcli +gen wand/vidu/text-to-video --model vidu-video-q3-turbo --prompt 猫 --seed 42` | seed | 请求体含 seed |
| vid-vidu-text-to-video-11 | --payload | `thcli +gen wand/vidu/text-to-video --model vidu-video-q3-turbo --prompt 猫 --payload x` | payload | 请求体含 payload |
| vid-vidu-text-to-video-12 | --watermark | `thcli +gen wand/vidu/text-to-video --model vidu-video-q3-turbo --prompt 猫 --watermark true` | watermark | 请求体含 watermark |
| vid-vidu-text-to-video-13 | --wm-position | `thcli +gen wand/vidu/text-to-video --model vidu-video-q3-turbo --prompt 猫 --wm-position 1` | wm_position | 请求体含 wm_position |
| vid-vidu-text-to-video-14 | --wm-url | `thcli +gen wand/vidu/text-to-video --model vidu-video-q3-turbo --prompt 猫 --wm-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/sneaker.png` | wm_url | 请求体含 wm_url |
| vid-vidu-text-to-video-15 | 缺 --prompt | `thcli +gen wand/vidu/text-to-video --model vidu-video-q3-turbo` | 必填校验 | 本地报「--prompt 必填」 |

### wand/vidu/image-to-video

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| vid-vidu-image-to-video-01 | 最小调用 | `thcli +gen wand/vidu/image-to-video --model vidu-video-q4-preview --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]'` | 必填字段 | 请求体含全部必填字段 |
| vid-vidu-image-to-video-02 | --prompt | `thcli +gen wand/vidu/image-to-video --model vidu-video-q4-preview --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --prompt 猫` | prompt | 请求体含 prompt |
| vid-vidu-image-to-video-03 | --audio | `thcli +gen wand/vidu/image-to-video --model vidu-video-q4-preview --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --audio true` | audio | 请求体含 audio |
| vid-vidu-image-to-video-04 | --audio-type | `thcli +gen wand/vidu/image-to-video --model vidu-video-q4-preview --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --audio-type all` | audio_type | 请求体含 audio_type |
| vid-vidu-image-to-video-05 | --voice-id | `thcli +gen wand/vidu/image-to-video --model vidu-video-q4-preview --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --voice-id custom_001` | voice_id | 请求体含 voice_id |
| vid-vidu-image-to-video-06 | --is-rec | `thcli +gen wand/vidu/image-to-video --model vidu-video-q4-preview --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --is-rec true` | is_rec | 请求体含 is_rec |
| vid-vidu-image-to-video-07 | --bgm | `thcli +gen wand/vidu/image-to-video --model vidu-video-q4-preview --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --bgm true` | bgm | 请求体含 bgm |
| vid-vidu-image-to-video-08 | --duration | `thcli +gen wand/vidu/image-to-video --model vidu-video-q4-preview --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --duration 5` | duration | 请求体含 duration |
| vid-vidu-image-to-video-09 | --resolution | `thcli +gen wand/vidu/image-to-video --model vidu-video-q4-preview --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --resolution 540p` | resolution | 请求体含 resolution |
| vid-vidu-image-to-video-10 | --movement-amplitude | `thcli +gen wand/vidu/image-to-video --model vidu-video-q4-preview --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --movement-amplitude auto` | movement_amplitude | 请求体含 movement_amplitude |
| vid-vidu-image-to-video-11 | --seed | `thcli +gen wand/vidu/image-to-video --model vidu-video-q4-preview --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --seed 42` | seed | 请求体含 seed |
| vid-vidu-image-to-video-12 | --payload | `thcli +gen wand/vidu/image-to-video --model vidu-video-q4-preview --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --payload x` | payload | 请求体含 payload |
| vid-vidu-image-to-video-13 | --watermark | `thcli +gen wand/vidu/image-to-video --model vidu-video-q4-preview --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --watermark true` | watermark | 请求体含 watermark |
| vid-vidu-image-to-video-14 | --wm-position | `thcli +gen wand/vidu/image-to-video --model vidu-video-q4-preview --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --wm-position 1` | wm_position | 请求体含 wm_position |
| vid-vidu-image-to-video-15 | --wm-url | `thcli +gen wand/vidu/image-to-video --model vidu-video-q4-preview --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --wm-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/sneaker.png` | wm_url | 请求体含 wm_url |
| vid-vidu-image-to-video-16 | 缺 --images | `thcli +gen wand/vidu/image-to-video --model vidu-video-q4-preview` | 必填校验 | 本地报「--images 必填」 |

### wand/vidu/start-end-to-video

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| vid-vidu-start-end-to-video-01 | 最小调用 | `thcli +gen wand/vidu/start-end-to-video --model vidu-video-q3-turbo --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]'` | 必填字段 | 请求体含全部必填字段 |
| vid-vidu-start-end-to-video-02 | --prompt | `thcli +gen wand/vidu/start-end-to-video --model vidu-video-q3-turbo --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --prompt 猫` | prompt | 请求体含 prompt |
| vid-vidu-start-end-to-video-03 | --is-rec | `thcli +gen wand/vidu/start-end-to-video --model vidu-video-q3-turbo --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --is-rec true` | is_rec | 请求体含 is_rec |
| vid-vidu-start-end-to-video-04 | --duration | `thcli +gen wand/vidu/start-end-to-video --model vidu-video-q3-turbo --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --duration 5` | duration | 请求体含 duration |
| vid-vidu-start-end-to-video-05 | --resolution | `thcli +gen wand/vidu/start-end-to-video --model vidu-video-q3-turbo --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --resolution 540p` | resolution | 请求体含 resolution |
| vid-vidu-start-end-to-video-06 | --movement-amplitude | `thcli +gen wand/vidu/start-end-to-video --model vidu-video-q3-turbo --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --movement-amplitude auto` | movement_amplitude | 请求体含 movement_amplitude |
| vid-vidu-start-end-to-video-07 | --audio | `thcli +gen wand/vidu/start-end-to-video --model vidu-video-q3-turbo --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --audio true` | audio | 请求体含 audio |
| vid-vidu-start-end-to-video-08 | --bgm | `thcli +gen wand/vidu/start-end-to-video --model vidu-video-q3-turbo --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --bgm true` | bgm | 请求体含 bgm |
| vid-vidu-start-end-to-video-09 | --seed | `thcli +gen wand/vidu/start-end-to-video --model vidu-video-q3-turbo --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --seed 42` | seed | 请求体含 seed |
| vid-vidu-start-end-to-video-10 | --payload | `thcli +gen wand/vidu/start-end-to-video --model vidu-video-q3-turbo --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --payload x` | payload | 请求体含 payload |
| vid-vidu-start-end-to-video-11 | --watermark | `thcli +gen wand/vidu/start-end-to-video --model vidu-video-q3-turbo --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --watermark true` | watermark | 请求体含 watermark |
| vid-vidu-start-end-to-video-12 | --wm-position | `thcli +gen wand/vidu/start-end-to-video --model vidu-video-q3-turbo --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --wm-position 1` | wm_position | 请求体含 wm_position |
| vid-vidu-start-end-to-video-13 | --wm-url | `thcli +gen wand/vidu/start-end-to-video --model vidu-video-q3-turbo --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]' --wm-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/sneaker.png` | wm_url | 请求体含 wm_url |
| vid-vidu-start-end-to-video-14 | 缺 --images | `thcli +gen wand/vidu/start-end-to-video --model vidu-video-q3-turbo` | 必填校验 | 本地报「--images 必填」 |

### wand/vidu/reference-to-video

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| vid-vidu-reference-to-video-01 | 最小调用 | `thcli +gen wand/vidu/reference-to-video --model vidu-video-q4-preview --prompt 猫 --images ../assets/images/portrait.jpg` | 必填字段 | 请求体含全部必填字段 |
| vid-vidu-reference-to-video-02 | --subjects | `thcli +gen wand/vidu/reference-to-video --model vidu-video-q4-preview --prompt 猫 --subjects '[{"name":"x"}]'` | subjects | 请求体含 subjects |
| vid-vidu-reference-to-video-03 | --images | `thcli +gen wand/vidu/reference-to-video --model vidu-video-q4-preview --prompt 猫 --images '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]'` | images | 请求体含 images |
| vid-vidu-reference-to-video-04 | --videos | `thcli +gen wand/vidu/reference-to-video --model vidu-video-q2-pro --prompt 猫 --videos '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/videos/dance-8s.mp4"]'` | videos | 请求体含 videos |
| vid-vidu-reference-to-video-05 | --auto-subjects | `thcli +gen wand/vidu/reference-to-video --model vidu-video-q4-preview --prompt 猫 --images ../assets/images/portrait.jpg --auto-subjects true` | auto_subjects | 请求体含 auto_subjects |
| vid-vidu-reference-to-video-06 | --audio | `thcli +gen wand/vidu/reference-to-video --model vidu-video-q4-preview --prompt 猫 --images ../assets/images/portrait.jpg --audio true` | audio | 请求体含 audio |
| vid-vidu-reference-to-video-07 | --audio-type | `thcli +gen wand/vidu/reference-to-video --model vidu-video-q4-preview --prompt 猫 --images ../assets/images/portrait.jpg --audio-type all` | audio_type | 请求体含 audio_type |
| vid-vidu-reference-to-video-08 | --duration | `thcli +gen wand/vidu/reference-to-video --model vidu-video-q4-preview --prompt 猫 --images ../assets/images/portrait.jpg --duration 5` | duration | 请求体含 duration |
| vid-vidu-reference-to-video-09 | --aspect-ratio | `thcli +gen wand/vidu/reference-to-video --model vidu-video-q4-preview --prompt 猫 --images ../assets/images/portrait.jpg --aspect-ratio 16:9` | aspect_ratio | 请求体含 aspect_ratio |
| vid-vidu-reference-to-video-10 | --resolution | `thcli +gen wand/vidu/reference-to-video --model vidu-video-q4-preview --prompt 猫 --images ../assets/images/portrait.jpg --resolution 540p` | resolution | 请求体含 resolution |
| vid-vidu-reference-to-video-11 | --movement-amplitude | `thcli +gen wand/vidu/reference-to-video --model vidu-video-q4-preview --prompt 猫 --images ../assets/images/portrait.jpg --movement-amplitude auto` | movement_amplitude | 请求体含 movement_amplitude |
| vid-vidu-reference-to-video-12 | --bgm | `thcli +gen wand/vidu/reference-to-video --model vidu-video-q4-preview --prompt 猫 --images ../assets/images/portrait.jpg --bgm true` | bgm | 请求体含 bgm |
| vid-vidu-reference-to-video-13 | --seed | `thcli +gen wand/vidu/reference-to-video --model vidu-video-q4-preview --prompt 猫 --images ../assets/images/portrait.jpg --seed 42` | seed | 请求体含 seed |
| vid-vidu-reference-to-video-14 | --payload | `thcli +gen wand/vidu/reference-to-video --model vidu-video-q4-preview --prompt 猫 --images ../assets/images/portrait.jpg --payload x` | payload | 请求体含 payload |
| vid-vidu-reference-to-video-15 | --watermark | `thcli +gen wand/vidu/reference-to-video --model vidu-video-q4-preview --prompt 猫 --images ../assets/images/portrait.jpg --watermark true` | watermark | 请求体含 watermark |
| vid-vidu-reference-to-video-16 | --wm-position | `thcli +gen wand/vidu/reference-to-video --model vidu-video-q4-preview --prompt 猫 --images ../assets/images/portrait.jpg --wm-position 1` | wm_position | 请求体含 wm_position |
| vid-vidu-reference-to-video-17 | --wm-url | `thcli +gen wand/vidu/reference-to-video --model vidu-video-q4-preview --prompt 猫 --images ../assets/images/portrait.jpg --wm-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/sneaker.png` | wm_url | 请求体含 wm_url |
| vid-vidu-reference-to-video-18 | 缺 --prompt | `thcli +gen wand/vidu/reference-to-video --model vidu-video-q4-preview --images ../assets/images/portrait.jpg` | 必填校验 | 本地报「--prompt 必填」 |
| vid-vidu-reference-to-video-19 | vidu-video-q4-preview 传 --videos | `thcli +gen wand/vidu/reference-to-video --model vidu-video-q4-preview --prompt 猫 --videos '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/videos/dance-8s.mp4"]'` | 适用模型 | 本地报「仅 vidu-video-q2-pro 支持」 |

### wand/pixverse/text-to-video

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| vid-pixverse-text-to-video-01 | 最小调用 | `thcli +gen wand/pixverse/text-to-video --model pixverse-video-v6.0 --prompt 猫 --duration 5 --quality 360p` | 必填字段 | 请求体含全部必填字段 |
| vid-pixverse-text-to-video-02 | --aspect-ratio | `thcli +gen wand/pixverse/text-to-video --model pixverse-video-v6.0 --prompt 猫 --duration 5 --quality 360p --aspect-ratio 16:9` | aspect_ratio | 请求体含 aspect_ratio |
| vid-pixverse-text-to-video-03 | --camera-movement | `thcli +gen wand/pixverse/text-to-video --model pixverse-video-v6.0 --prompt 猫 --duration 5 --quality 360p --camera-movement zoom_in` | camera_movement | 请求体含 camera_movement |
| vid-pixverse-text-to-video-04 | --seed | `thcli +gen wand/pixverse/text-to-video --model pixverse-video-v6.0 --prompt 猫 --duration 5 --quality 360p --seed 42` | seed | 请求体含 seed |
| vid-pixverse-text-to-video-05 | --generate-audio-switch | `thcli +gen wand/pixverse/text-to-video --model pixverse-video-v6.0 --prompt 猫 --duration 5 --quality 360p --generate-audio-switch true` | generate_audio_switch | 请求体含 generate_audio_switch |
| vid-pixverse-text-to-video-06 | --generate-multi-clip-switch | `thcli +gen wand/pixverse/text-to-video --model pixverse-video-v6.0 --prompt 猫 --duration 5 --quality 360p --generate-multi-clip-switch true` | generate_multi_clip_switch | 请求体含 generate_multi_clip_switch |
| vid-pixverse-text-to-video-07 | 缺 --prompt | `thcli +gen wand/pixverse/text-to-video --model pixverse-video-v6.0 --duration 5 --quality 360p` | 必填校验 | 本地报「--prompt 必填」 |
| vid-pixverse-text-to-video-08 | 缺 --duration | `thcli +gen wand/pixverse/text-to-video --model pixverse-video-v6.0 --prompt 猫 --quality 360p` | 必填校验 | 本地报「--duration 必填」 |
| vid-pixverse-text-to-video-09 | 缺 --quality | `thcli +gen wand/pixverse/text-to-video --model pixverse-video-v6.0 --prompt 猫 --duration 5` | 必填校验 | 本地报「--quality 必填」 |
| vid-pixverse-text-to-video-10 | pixverse-video-c1 传 --generate-multi-clip-switch | `thcli +gen wand/pixverse/text-to-video --model pixverse-video-c1 --prompt 猫 --duration 5 --quality 360p --generate-multi-clip-switch true` | 适用模型 | 本地报「仅 pixverse-video-v6.0 支持」 |

### wand/pixverse/image-to-video

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| vid-pixverse-image-to-video-01 | 最小调用 | `thcli +gen wand/pixverse/image-to-video --model pixverse-video-v6.0 --img-id ../assets/images/cat-window.jpg --prompt 猫 --duration 5 --quality 360p` | 必填字段 | 请求体含全部必填字段 |
| vid-pixverse-image-to-video-02 | --img-ids | `thcli +gen wand/pixverse/image-to-video --model pixverse-video-v6.0 --img-id ../assets/images/cat-window.jpg --prompt 猫 --duration 5 --quality 360p --img-ids '["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]'` | img_ids | 请求体含 img_ids |
| vid-pixverse-image-to-video-03 | --camera-movement | `thcli +gen wand/pixverse/image-to-video --model pixverse-video-v6.0 --img-id ../assets/images/cat-window.jpg --prompt 猫 --duration 5 --quality 360p --camera-movement zoom_in` | camera_movement | 请求体含 camera_movement |
| vid-pixverse-image-to-video-04 | --seed | `thcli +gen wand/pixverse/image-to-video --model pixverse-video-v6.0 --img-id ../assets/images/cat-window.jpg --prompt 猫 --duration 5 --quality 360p --seed 42` | seed | 请求体含 seed |
| vid-pixverse-image-to-video-05 | --generate-audio-switch | `thcli +gen wand/pixverse/image-to-video --model pixverse-video-v6.0 --img-id ../assets/images/cat-window.jpg --prompt 猫 --duration 5 --quality 360p --generate-audio-switch true` | generate_audio_switch | 请求体含 generate_audio_switch |
| vid-pixverse-image-to-video-06 | --generate-multi-clip-switch | `thcli +gen wand/pixverse/image-to-video --model pixverse-video-v6.0 --img-id ../assets/images/cat-window.jpg --prompt 猫 --duration 5 --quality 360p --generate-multi-clip-switch true` | generate_multi_clip_switch | 请求体含 generate_multi_clip_switch |
| vid-pixverse-image-to-video-07 | 缺 --img-id | `thcli +gen wand/pixverse/image-to-video --model pixverse-video-v6.0 --prompt 猫 --duration 5 --quality 360p` | 必填校验 | 本地报「--img-id 必填」 |
| vid-pixverse-image-to-video-08 | 缺 --prompt | `thcli +gen wand/pixverse/image-to-video --model pixverse-video-v6.0 --img-id ../assets/images/cat-window.jpg --duration 5 --quality 360p` | 必填校验 | 本地报「--prompt 必填」 |
| vid-pixverse-image-to-video-09 | 缺 --duration | `thcli +gen wand/pixverse/image-to-video --model pixverse-video-v6.0 --img-id ../assets/images/cat-window.jpg --prompt 猫 --quality 360p` | 必填校验 | 本地报「--duration 必填」 |
| vid-pixverse-image-to-video-10 | 缺 --quality | `thcli +gen wand/pixverse/image-to-video --model pixverse-video-v6.0 --img-id ../assets/images/cat-window.jpg --prompt 猫 --duration 5` | 必填校验 | 本地报「--quality 必填」 |
| vid-pixverse-image-to-video-11 | pixverse-video-c1 传 --generate-multi-clip-switch | `thcli +gen wand/pixverse/image-to-video --model pixverse-video-c1 --img-id ../assets/images/cat-window.jpg --prompt 猫 --duration 5 --quality 360p --generate-multi-clip-switch true` | 适用模型 | 本地报「仅 pixverse-video-v6.0 支持」 |
| vid-pixverse-image-to-video-12 | --img-ids 本地文件 | `thcli +gen wand/pixverse/image-to-video --model pixverse-video-v6.0 --img-id ../assets/images/cat-window.jpg --prompt 猫 --duration 5 --quality 360p --img-ids <含本地路径的 JSON>` | 只收 URL | 本地报「只收公网 URL」 |

### wand/pixverse/start-end-to-video

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| vid-pixverse-start-end-to-video-01 | 最小调用 | `thcli +gen wand/pixverse/start-end-to-video --model pixverse-video-v6.0 --prompt 猫 --first-frame-img ../assets/images/cat-window.jpg --last-frame-img ../assets/images/cat-window.jpg --duration 5 --quality 360p` | 必填字段 | 请求体含全部必填字段 |
| vid-pixverse-start-end-to-video-02 | --seed | `thcli +gen wand/pixverse/start-end-to-video --model pixverse-video-v6.0 --prompt 猫 --first-frame-img ../assets/images/cat-window.jpg --last-frame-img ../assets/images/cat-window.jpg --duration 5 --quality 360p --seed 42` | seed | 请求体含 seed |
| vid-pixverse-start-end-to-video-03 | --generate-audio-switch | `thcli +gen wand/pixverse/start-end-to-video --model pixverse-video-v6.0 --prompt 猫 --first-frame-img ../assets/images/cat-window.jpg --last-frame-img ../assets/images/cat-window.jpg --duration 5 --quality 360p --generate-audio-switch true` | generate_audio_switch | 请求体含 generate_audio_switch |
| vid-pixverse-start-end-to-video-04 | 缺 --prompt | `thcli +gen wand/pixverse/start-end-to-video --model pixverse-video-v6.0 --first-frame-img ../assets/images/cat-window.jpg --last-frame-img ../assets/images/cat-window.jpg --duration 5 --quality 360p` | 必填校验 | 本地报「--prompt 必填」 |
| vid-pixverse-start-end-to-video-05 | 缺 --first-frame-img | `thcli +gen wand/pixverse/start-end-to-video --model pixverse-video-v6.0 --prompt 猫 --last-frame-img ../assets/images/cat-window.jpg --duration 5 --quality 360p` | 必填校验 | 本地报「--first-frame-img 必填」 |
| vid-pixverse-start-end-to-video-06 | 缺 --last-frame-img | `thcli +gen wand/pixverse/start-end-to-video --model pixverse-video-v6.0 --prompt 猫 --first-frame-img ../assets/images/cat-window.jpg --duration 5 --quality 360p` | 必填校验 | 本地报「--last-frame-img 必填」 |
| vid-pixverse-start-end-to-video-07 | 缺 --duration | `thcli +gen wand/pixverse/start-end-to-video --model pixverse-video-v6.0 --prompt 猫 --first-frame-img ../assets/images/cat-window.jpg --last-frame-img ../assets/images/cat-window.jpg --quality 360p` | 必填校验 | 本地报「--duration 必填」 |
| vid-pixverse-start-end-to-video-08 | 缺 --quality | `thcli +gen wand/pixverse/start-end-to-video --model pixverse-video-v6.0 --prompt 猫 --first-frame-img ../assets/images/cat-window.jpg --last-frame-img ../assets/images/cat-window.jpg --duration 5` | 必填校验 | 本地报「--quality 必填」 |

### wand/pixverse/reference-to-video

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| vid-pixverse-reference-to-video-01 | 最小调用 | `thcli +gen wand/pixverse/reference-to-video --model pixverse-video-v6.0 --image-references '[{"img_id":"x"}]' --prompt 猫 --duration 5 --quality 360p` | 必填字段 | 请求体含全部必填字段 |
| vid-pixverse-reference-to-video-02 | --aspect-ratio | `thcli +gen wand/pixverse/reference-to-video --model pixverse-video-v6.0 --image-references '[{"img_id":"x"}]' --prompt 猫 --duration 5 --quality 360p --aspect-ratio 16:9` | aspect_ratio | 请求体含 aspect_ratio |
| vid-pixverse-reference-to-video-03 | --generate-audio-switch | `thcli +gen wand/pixverse/reference-to-video --model pixverse-video-v6.0 --image-references '[{"img_id":"x"}]' --prompt 猫 --duration 5 --quality 360p --generate-audio-switch true` | generate_audio_switch | 请求体含 generate_audio_switch |
| vid-pixverse-reference-to-video-04 | --seed | `thcli +gen wand/pixverse/reference-to-video --model pixverse-video-v6.0 --image-references '[{"img_id":"x"}]' --prompt 猫 --duration 5 --quality 360p --seed 42` | seed | 请求体含 seed |
| vid-pixverse-reference-to-video-05 | 缺 --image-references | `thcli +gen wand/pixverse/reference-to-video --model pixverse-video-v6.0 --prompt 猫 --duration 5 --quality 360p` | 必填校验 | 本地报「--image-references 必填」 |
| vid-pixverse-reference-to-video-06 | 缺 --prompt | `thcli +gen wand/pixverse/reference-to-video --model pixverse-video-v6.0 --image-references '[{"img_id":"x"}]' --duration 5 --quality 360p` | 必填校验 | 本地报「--prompt 必填」 |
| vid-pixverse-reference-to-video-07 | 缺 --duration | `thcli +gen wand/pixverse/reference-to-video --model pixverse-video-v6.0 --image-references '[{"img_id":"x"}]' --prompt 猫 --quality 360p` | 必填校验 | 本地报「--duration 必填」 |
| vid-pixverse-reference-to-video-08 | 缺 --quality | `thcli +gen wand/pixverse/reference-to-video --model pixverse-video-v6.0 --image-references '[{"img_id":"x"}]' --prompt 猫 --duration 5` | 必填校验 | 本地报「--quality 必填」 |

### wand/minimax-video/generation

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| vid-minimax-video-generation-01 | 最小调用 | `thcli +gen wand/minimax-video/generation --model minimax-video-v2.3 --prompt 猫` | 必填字段 | 请求体含全部必填字段 |
| vid-minimax-video-generation-02 | --prompt | `thcli +gen wand/minimax-video/generation --model minimax-video-v2.3 --prompt 猫` | prompt | 请求体含 prompt |
| vid-minimax-video-generation-03 | --prompt-optimizer | `thcli +gen wand/minimax-video/generation --model minimax-video-v2.3 --prompt 猫 --prompt-optimizer true` | prompt_optimizer | 请求体含 prompt_optimizer |
| vid-minimax-video-generation-04 | --fast-pretreatment | `thcli +gen wand/minimax-video/generation --model minimax-video-v2.3 --prompt 猫 --fast-pretreatment true` | fast_pretreatment | 请求体含 fast_pretreatment |
| vid-minimax-video-generation-05 | --duration | `thcli +gen wand/minimax-video/generation --model minimax-video-v2.3 --prompt 猫 --duration 5` | duration | 请求体含 duration |
| vid-minimax-video-generation-06 | --resolution | `thcli +gen wand/minimax-video/generation --model minimax-video-v2.3 --prompt 猫 --resolution 768P` | resolution | 请求体含 resolution |
| vid-minimax-video-generation-07 | --aigc-watermark | `thcli +gen wand/minimax-video/generation --model minimax-video-v2.3 --prompt 猫 --aigc-watermark true` | aigc_watermark | 请求体含 aigc_watermark |
| vid-minimax-video-generation-08 | --first-frame-image | `thcli +gen wand/minimax-video/generation --model minimax-video-v2.3 --prompt 猫 --first-frame-image ../assets/images/cat-window.jpg` | first_frame_image | 请求体含 first_frame_image |
| vid-minimax-video-generation-09 | --last-frame-image | `thcli +gen wand/minimax-video/generation --model minimax-video-v2.3 --prompt 猫 --last-frame-image ../assets/images/cat-window.jpg` | last_frame_image | 请求体含 last_frame_image |
| vid-minimax-video-generation-10 | minimax-video-v2.3-fast 传 --last-frame-image | `thcli +gen wand/minimax-video/generation --model minimax-video-v2.3-fast --first-frame-image ../assets/images/cat-window.jpg --prompt 猫 --last-frame-image ../assets/images/cat-window.jpg` | 适用模型 | 本地报「仅 minimax-video-v2.3 支持」 |

### wand/minimax-video-v2/generation

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| vid-minimax-video-v2-generation-01 | 最小调用 | `thcli +gen wand/minimax-video-v2/generation --model minimax-video-h3 --content '[{"type":"text","text":"猫"}]' --resolution 768P --duration 6 --ratio 16:9` | 必填字段 | 请求体含全部必填字段 |
| vid-minimax-video-v2-generation-02 | --ratio | `thcli +gen wand/minimax-video-v2/generation --model minimax-video-h3 --content '[{"type":"text","text":"猫"}]' --resolution 768P --duration 6 --ratio 21:9` | ratio | 请求体含 ratio |
| vid-minimax-video-v2-generation-03 | --aigc-watermark | `thcli +gen wand/minimax-video-v2/generation --model minimax-video-h3 --content '[{"type":"text","text":"猫"}]' --resolution 768P --duration 6 --ratio 16:9 --aigc-watermark true` | aigc_watermark | 请求体含 aigc_watermark |
| vid-minimax-video-v2-generation-04 | --extra | `thcli +gen wand/minimax-video-v2/generation --model minimax-video-h3 --content '[{"type":"text","text":"猫"}]' --resolution 768P --duration 6 --ratio 16:9 --extra '{"prompt_expansion_mode":"disabled"}'` | extra | 请求体含 extra |
| vid-minimax-video-v2-generation-05 | 缺 --content | `thcli +gen wand/minimax-video-v2/generation --model minimax-video-h3 --resolution 768P --duration 6 --ratio 16:9` | 必填校验 | 本地报「--content 必填」 |
| vid-minimax-video-v2-generation-06 | 缺 --resolution | `thcli +gen wand/minimax-video-v2/generation --model minimax-video-h3 --content '[{"type":"text","text":"猫"}]' --duration 6 --ratio 16:9` | 必填校验 | 本地报「--resolution 必填」 |
| vid-minimax-video-v2-generation-07 | 缺 --duration | `thcli +gen wand/minimax-video-v2/generation --model minimax-video-h3 --content '[{"type":"text","text":"猫"}]' --resolution 768P --ratio 16:9` | 必填校验 | 本地报「--duration 必填」 |

### wand/vega-videos/tasks

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| vid-vega-videos-tasks-01 | 最小调用 | `thcli +gen wand/vega-videos/tasks --content '[{"type":"text","text":"猫"}]'` | 必填字段 | 请求体含全部必填字段 |
| vid-vega-videos-tasks-02 | --resolution | `thcli +gen wand/vega-videos/tasks --content '[{"type":"text","text":"猫"}]' --resolution 768P` | resolution | 请求体含 resolution |
| vid-vega-videos-tasks-03 | --ratio | `thcli +gen wand/vega-videos/tasks --content '[{"type":"text","text":"猫"}]' --ratio 21:9` | ratio | 请求体含 ratio |
| vid-vega-videos-tasks-04 | --duration | `thcli +gen wand/vega-videos/tasks --content '[{"type":"text","text":"猫"}]' --duration 5` | duration | 请求体含 duration |
| vid-vega-videos-tasks-05 | --options | `thcli +gen wand/vega-videos/tasks --content '[{"type":"text","text":"猫"}]' --options '{"return_last_frame":true}'` | options | 请求体含 options |
| vid-vega-videos-tasks-06 | 缺 --content | `thcli +gen wand/vega-videos/tasks` | 必填校验 | 本地报「--content 必填」 |

## 3D

| 接口 | 模型 | 字段（* 必填） | 用例数 |
|---|---|---|---|
| [api/3d/submit](#api3dsubmit) | hy-3d-3.0 / hy-3d-3.1 / hy-3d-express | --prompt --image-base64 --image-url --multi-view-images --enable-pbr --face-count --generate-type --polygon-type --result-format --enable-geometry | 17 |
| [wand/hunyuan-image/world2-panorama](#wandhunyuan-imageworld2-panorama) | hy-world2-panorama | *--prompt --image-url | 4 |
| [wand/hunyuan-video/world2-scene](#wandhunyuan-videoworld2-scene) | hy-world2-scene | --prompt --image-url | 4 |

### api/3d/submit

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| 3d-3d-submit-01 | 最小调用 | `thcli +gen api/3d/submit --model hy-3d-3.0 --prompt 狗` | 必填字段 | 请求体含全部必填字段 |
| 3d-3d-submit-02 | --prompt | `thcli +gen api/3d/submit --model hy-3d-3.0 --prompt 猫` | prompt | 请求体含 prompt |
| 3d-3d-submit-03 | --image-base64 | `thcli +gen api/3d/submit --model hy-3d-3.0 --image-base64 ../assets/images/cat-window.jpg` | image_base64 | 请求体含 image_base64 |
| 3d-3d-submit-04 | --image-url | `thcli +gen api/3d/submit --model hy-3d-3.0 --image-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg` | image_url | 请求体含 image_url |
| 3d-3d-submit-05 | --multi-view-images | `thcli +gen api/3d/submit --model hy-3d-3.0 --prompt 狗 --multi-view-images '[{"view_type":"left","view_image_url":"x"}]'` | multi_view_images | 请求体含 multi_view_images |
| 3d-3d-submit-06 | --enable-pbr | `thcli +gen api/3d/submit --model hy-3d-3.0 --prompt 狗 --enable-pbr true` | enable_pbr | 请求体含 enable_pbr |
| 3d-3d-submit-07 | --face-count | `thcli +gen api/3d/submit --model hy-3d-3.0 --prompt 狗 --face-count 1` | face_count | 请求体含 face_count |
| 3d-3d-submit-08 | --generate-type | `thcli +gen api/3d/submit --model hy-3d-3.0 --prompt 狗 --generate-type Normal` | generate_type | 请求体含 generate_type |
| 3d-3d-submit-09 | --polygon-type | `thcli +gen api/3d/submit --model hy-3d-3.0 --prompt 狗 --polygon-type triangle` | polygon_type | 请求体含 polygon_type |
| 3d-3d-submit-10 | --result-format | `thcli +gen api/3d/submit --model hy-3d-3.0 --prompt 狗 --result-format STL` | result_format | 请求体含 result_format |
| 3d-3d-submit-11 | --enable-geometry | `thcli +gen api/3d/submit --model hy-3d-express --prompt 狗 --enable-geometry true` | enable_geometry | 请求体含 enable_geometry |
| 3d-3d-submit-12 | hy-3d-express 传 --multi-view-images | `thcli +gen api/3d/submit --model hy-3d-express --prompt 狗 --multi-view-images '[{"view_type":"left","view_image_url":"x"}]'` | 适用模型 | 本地报「仅 hy-3d-3.0 / hy-3d-3.1 支持」 |
| 3d-3d-submit-13 | hy-3d-express 传 --face-count | `thcli +gen api/3d/submit --model hy-3d-express --prompt 狗 --face-count 1` | 适用模型 | 本地报「仅 hy-3d-3.0 / hy-3d-3.1 支持」 |
| 3d-3d-submit-14 | hy-3d-express 传 --generate-type | `thcli +gen api/3d/submit --model hy-3d-express --prompt 狗 --generate-type Normal` | 适用模型 | 本地报「仅 hy-3d-3.0 / hy-3d-3.1 支持」 |
| 3d-3d-submit-15 | hy-3d-3.1 传 --polygon-type | `thcli +gen api/3d/submit --model hy-3d-3.1 --prompt 狗 --polygon-type triangle` | 适用模型 | 本地报「仅 hy-3d-3.0 支持」 |
| 3d-3d-submit-16 | hy-3d-3.0 传 --enable-geometry | `thcli +gen api/3d/submit --model hy-3d-3.0 --prompt 狗 --enable-geometry true` | 适用模型 | 本地报「仅 hy-3d-express 支持」 |
| 3d-3d-submit-17 | --image-url 本地文件 | `thcli +gen api/3d/submit --model hy-3d-3.0 --image-url ../assets/images/cat-window.jpg` | 只收 URL | 本地报「只收公网 URL」 |

### wand/hunyuan-image/world2-panorama

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| 3d-hunyuan-image-world2-panorama-01 | 最小调用 | `thcli +gen wand/hunyuan-image/world2-panorama --prompt 猫` | 必填字段 | 请求体含全部必填字段 |
| 3d-hunyuan-image-world2-panorama-02 | --image-url | `thcli +gen wand/hunyuan-image/world2-panorama --prompt 猫 --image-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg` | image_url | 请求体含 image_url |
| 3d-hunyuan-image-world2-panorama-03 | 缺 --prompt | `thcli +gen wand/hunyuan-image/world2-panorama` | 必填校验 | 本地报「--prompt 必填」 |
| 3d-hunyuan-image-world2-panorama-04 | --image-url 本地文件 | `thcli +gen wand/hunyuan-image/world2-panorama --prompt 猫 --image-url ../assets/images/cat-window.jpg` | 只收 URL | 本地报「只收公网 URL」 |

### wand/hunyuan-video/world2-scene

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| 3d-hunyuan-video-world2-scene-01 | 最小调用 | `thcli +gen wand/hunyuan-video/world2-scene --prompt 场景` | 必填字段 | 请求体含全部必填字段 |
| 3d-hunyuan-video-world2-scene-02 | --prompt | `thcli +gen wand/hunyuan-video/world2-scene --prompt 猫` | prompt | 请求体含 prompt |
| 3d-hunyuan-video-world2-scene-03 | --image-url | `thcli +gen wand/hunyuan-video/world2-scene --image-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg` | image_url | 请求体含 image_url |
| 3d-hunyuan-video-world2-scene-04 | --image-url 本地文件 | `thcli +gen wand/hunyuan-video/world2-scene --image-url ../assets/images/cat-window.jpg` | 只收 URL | 本地报「只收公网 URL」 |

## 语音

| 接口 | 模型 | 字段（* 必填） | 用例数 |
|---|---|---|---|
| [wand/asrproxy/sync_transcribe](#wandasrproxysynctranscribe) | hy-asr-3.0-preview / wand-asr-v1 | --input-url --data --source --voice-encode-format | 6 |
| [wand/asrproxy/async_create](#wandasrproxyasynccreate) | hy-asr-3.0-preview / wand-asr-v1 | *--input-url --source --subtitle-format | 5 |
| [tenlai/asrproxy/create_rec_task](#tenlaiasrproxycreaterectask) | tenlai-asr-v1.0 | --input-url --data | 4 |
| [wand/minimax-tts/sync_tts](#wandminimax-ttssynctts) | minimax-speech-2.8-hd / minimax-speech-2.8-turbo / minimax-speech-2.6-hd / minimax-speech-2.6-turbo / minimax-speech-02-hd / minimax-speech-02-turbo | *--text *--voice-setting --audio-setting --pronunciation-dict --timbre-weights --language-boost --voice-modify --subtitle-enable --subtitle-type --stream --output-format --aigc-watermark | 13 |
| [wand/minimax-tts/sync_clone](#wandminimax-ttssyncclone) | minimax-voice-clone | --audio-url --audio-data --file-id --tts-model --voice-id --text --text-validation --accuracy --output-format | 11 |
| [wand/minimax-tts/sync_design](#wandminimax-ttssyncdesign) | minimax-voice-design | *--prompt *--preview-text --voice-id --output-format --aigc-watermark | 6 |
| [wand/dubbing/async_generation](#wanddubbingasyncgeneration) | wand-dubbing-clone-v1 / wand-dubbing-clone-v2 | *--input-url --src-language --dst-language | 4 |
| [wand/minimax-music/generation](#wandminimax-musicgeneration) | minimax-music-v3.0 / minimax-music-v2.6 | --prompt --lyrics --lyrics-optimizer --is-instrumental --output-format --audio-setting --aigc-watermark | 8 |
| [wand/mureka-music/generation](#wandmureka-musicgeneration) | mureka-music-v9 | *--lyrics --prompt --gender --n | 5 |
| [wand/mureka-music/easy-generation](#wandmureka-musiceasy-generation) | mureka-music-v9 | *--prompt --styles --n | 4 |
| [wand/mureka-music/instrumental-generation](#wandmureka-musicinstrumental-generation) | mureka-music-v9 | *--prompt --n | 3 |

### wand/asrproxy/sync_transcribe

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| aud-asrproxy-synctranscribe-01 | 最小调用 | `thcli +gen wand/asrproxy/sync_transcribe --model hy-asr-3.0-preview --input-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/audio/speech-zh-10s.wav` | 必填字段 | 请求体含全部必填字段 |
| aud-asrproxy-synctranscribe-02 | --input-url | `thcli +gen wand/asrproxy/sync_transcribe --model hy-asr-3.0-preview --input-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/videos/dub-video.mp4` | input_url | 请求体含 input_url |
| aud-asrproxy-synctranscribe-03 | --data | `thcli +gen wand/asrproxy/sync_transcribe --model hy-asr-3.0-preview --data ../assets/audio/speech-zh-10s.wav` | data | 请求体含 data |
| aud-asrproxy-synctranscribe-04 | --source | `thcli +gen wand/asrproxy/sync_transcribe --model hy-asr-3.0-preview --input-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/audio/speech-zh-10s.wav --source af-ZA` | source | 请求体含 source |
| aud-asrproxy-synctranscribe-05 | --voice-encode-format | `thcli +gen wand/asrproxy/sync_transcribe --model hy-asr-3.0-preview --input-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/audio/speech-zh-10s.wav --voice-encode-format auto` | voice_encode_format | 请求体含 voice_encode_format |
| aud-asrproxy-synctranscribe-06 | --input-url 本地文件 | `thcli +gen wand/asrproxy/sync_transcribe --model hy-asr-3.0-preview --input-url ../assets/images/cat-window.jpg` | 只收 URL | 本地报「只收公网 URL」 |

### wand/asrproxy/async_create

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| aud-asrproxy-asynccreate-01 | 最小调用 | `thcli +gen wand/asrproxy/async_create --model hy-asr-3.0-preview --input-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/videos/dub-video.mp4` | 必填字段 | 请求体含全部必填字段 |
| aud-asrproxy-asynccreate-02 | --source | `thcli +gen wand/asrproxy/async_create --model hy-asr-3.0-preview --input-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/videos/dub-video.mp4 --source af-ZA` | source | 请求体含 source |
| aud-asrproxy-asynccreate-03 | --subtitle-format | `thcli +gen wand/asrproxy/async_create --model hy-asr-3.0-preview --input-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/videos/dub-video.mp4 --subtitle-format srt` | subtitle_format | 请求体含 subtitle_format |
| aud-asrproxy-asynccreate-04 | 缺 --input-url | `thcli +gen wand/asrproxy/async_create --model hy-asr-3.0-preview` | 必填校验 | 本地报「--input-url 必填」 |
| aud-asrproxy-asynccreate-05 | --input-url 本地文件 | `thcli +gen wand/asrproxy/async_create --model hy-asr-3.0-preview --input-url ../assets/images/cat-window.jpg` | 只收 URL | 本地报「只收公网 URL」 |

### tenlai/asrproxy/create_rec_task

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| aud-asrproxy-createrectask-01 | 最小调用 | `thcli +gen tenlai/asrproxy/create_rec_task` | 必填字段 | 请求体含全部必填字段 |
| aud-asrproxy-createrectask-02 | --input-url | `thcli +gen tenlai/asrproxy/create_rec_task --input-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/videos/dub-video.mp4` | input_url | 请求体含 input_url |
| aud-asrproxy-createrectask-03 | --data | `thcli +gen tenlai/asrproxy/create_rec_task --data ../assets/audio/speech-zh-10s.wav` | data | 请求体含 data |
| aud-asrproxy-createrectask-04 | --input-url 本地文件 | `thcli +gen tenlai/asrproxy/create_rec_task --input-url ../assets/images/cat-window.jpg` | 只收 URL | 本地报「只收公网 URL」 |

### wand/minimax-tts/sync_tts

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| aud-minimax-tts-synctts-01 | 最小调用 | `thcli +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 猫 --voice-setting '{"voice_id":"male-qn-qingse"}'` | 必填字段 | 请求体含全部必填字段 |
| aud-minimax-tts-synctts-02 | --audio-setting | `thcli +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 猫 --voice-setting '{"voice_id":"male-qn-qingse"}' --audio-setting '{"sample_rate":8000}'` | audio_setting | 请求体含 audio_setting |
| aud-minimax-tts-synctts-03 | --pronunciation-dict | `thcli +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 猫 --voice-setting '{"voice_id":"male-qn-qingse"}' --pronunciation-dict '{"tone":["https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/images/cat-window.jpg"]}'` | pronunciation_dict | 请求体含 pronunciation_dict |
| aud-minimax-tts-synctts-04 | --timbre-weights | `thcli +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 猫 --voice-setting '{"voice_id":"male-qn-qingse"}' --timbre-weights '[{"voice_id":"x","weight":1}]'` | timbre_weights | 请求体含 timbre_weights |
| aud-minimax-tts-synctts-05 | --language-boost | `thcli +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 猫 --voice-setting '{"voice_id":"male-qn-qingse"}' --language-boost auto` | language_boost | 请求体含 language_boost |
| aud-minimax-tts-synctts-06 | --voice-modify | `thcli +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 猫 --voice-setting '{"voice_id":"male-qn-qingse"}' --voice-modify '{"pitch":-100}'` | voice_modify | 请求体含 voice_modify |
| aud-minimax-tts-synctts-07 | --subtitle-enable | `thcli +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 猫 --voice-setting '{"voice_id":"male-qn-qingse"}' --subtitle-enable true` | subtitle_enable | 请求体含 subtitle_enable |
| aud-minimax-tts-synctts-08 | --subtitle-type | `thcli +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 猫 --voice-setting '{"voice_id":"male-qn-qingse"}' --subtitle-type sentence` | subtitle_type | 请求体含 subtitle_type |
| aud-minimax-tts-synctts-09 | --stream | `thcli +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 猫 --voice-setting '{"voice_id":"male-qn-qingse"}' --stream true` | stream | 请求体含 stream |
| aud-minimax-tts-synctts-10 | --output-format | `thcli +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 猫 --voice-setting '{"voice_id":"male-qn-qingse"}' --output-format hex` | output_format | 请求体含 output_format |
| aud-minimax-tts-synctts-11 | --aigc-watermark | `thcli +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 猫 --voice-setting '{"voice_id":"male-qn-qingse"}' --aigc-watermark true` | aigc_watermark | 请求体含 aigc_watermark |
| aud-minimax-tts-synctts-12 | 缺 --text | `thcli +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --voice-setting '{"voice_id":"male-qn-qingse"}'` | 必填校验 | 本地报「--text 必填」 |
| aud-minimax-tts-synctts-13 | 缺 --voice-setting | `thcli +gen wand/minimax-tts/sync_tts --model minimax-speech-2.8-hd --text 猫` | 必填校验 | 本地报「--voice-setting 必填」 |

### wand/minimax-tts/sync_clone

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| aud-minimax-tts-syncclone-01 | 最小调用 | `thcli +gen wand/minimax-tts/sync_clone --audio-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/audio/ref6s.mp3` | 必填字段 | 请求体含全部必填字段 |
| aud-minimax-tts-syncclone-02 | --audio-url | `thcli +gen wand/minimax-tts/sync_clone --audio-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/audio/speech-zh-10s.wav` | audio_url | 请求体含 audio_url |
| aud-minimax-tts-syncclone-03 | --audio-data | `thcli +gen wand/minimax-tts/sync_clone --audio-data ../assets/audio/speech-zh-10s.wav` | audio_data | 请求体含 audio_data |
| aud-minimax-tts-syncclone-04 | --file-id | `thcli +gen wand/minimax-tts/sync_clone --audio-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/audio/ref6s.mp3 --file-id 1` | file_id | 请求体含 file_id |
| aud-minimax-tts-syncclone-05 | --tts-model | `thcli +gen wand/minimax-tts/sync_clone --audio-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/audio/ref6s.mp3 --tts-model minimax-speech-2.8-turbo` | tts_model | 请求体含 tts_model |
| aud-minimax-tts-syncclone-06 | --voice-id | `thcli +gen wand/minimax-tts/sync_clone --audio-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/audio/ref6s.mp3 --voice-id custom_001` | voice_id | 请求体含 voice_id |
| aud-minimax-tts-syncclone-07 | --text | `thcli +gen wand/minimax-tts/sync_clone --audio-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/audio/ref6s.mp3 --text 猫` | text | 请求体含 text |
| aud-minimax-tts-syncclone-08 | --text-validation | `thcli +gen wand/minimax-tts/sync_clone --audio-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/audio/ref6s.mp3 --text-validation x` | text_validation | 请求体含 text_validation |
| aud-minimax-tts-syncclone-09 | --accuracy | `thcli +gen wand/minimax-tts/sync_clone --audio-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/audio/ref6s.mp3 --accuracy 0.8` | accuracy | 请求体含 accuracy |
| aud-minimax-tts-syncclone-10 | --output-format | `thcli +gen wand/minimax-tts/sync_clone --audio-url https://mps-ollie-test-1308104797.cos.ap-guangzhou.myqcloud.com/thcli-assets/audio/ref6s.mp3 --output-format hex` | output_format | 请求体含 output_format |
| aud-minimax-tts-syncclone-11 | --audio-url 本地文件 | `thcli +gen wand/minimax-tts/sync_clone --audio-url ../assets/images/cat-window.jpg` | 只收 URL | 本地报「只收公网 URL」 |

### wand/minimax-tts/sync_design

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| aud-minimax-tts-syncdesign-01 | 最小调用 | `thcli +gen wand/minimax-tts/sync_design --prompt 猫 --preview-text 你好` | 必填字段 | 请求体含全部必填字段 |
| aud-minimax-tts-syncdesign-02 | --voice-id | `thcli +gen wand/minimax-tts/sync_design --prompt 猫 --preview-text 你好 --voice-id custom_001` | voice_id | 请求体含 voice_id |
| aud-minimax-tts-syncdesign-03 | --output-format | `thcli +gen wand/minimax-tts/sync_design --prompt 猫 --preview-text 你好 --output-format hex` | output_format | 请求体含 output_format |
| aud-minimax-tts-syncdesign-04 | --aigc-watermark | `thcli +gen wand/minimax-tts/sync_design --prompt 猫 --preview-text 你好 --aigc-watermark true` | aigc_watermark | 请求体含 aigc_watermark |
| aud-minimax-tts-syncdesign-05 | 缺 --prompt | `thcli +gen wand/minimax-tts/sync_design --preview-text 你好` | 必填校验 | 本地报「--prompt 必填」 |
| aud-minimax-tts-syncdesign-06 | 缺 --preview-text | `thcli +gen wand/minimax-tts/sync_design --prompt 猫` | 必填校验 | 本地报「--preview-text 必填」 |

### wand/dubbing/async_generation

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| aud-dubbing-asyncgeneration-01 | 最小调用 | `thcli +gen wand/dubbing/async_generation --model wand-dubbing-clone-v1 --input-url ../assets/videos/dub-video.mp4` | 必填字段 | 请求体含全部必填字段 |
| aud-dubbing-asyncgeneration-02 | --src-language | `thcli +gen wand/dubbing/async_generation --model wand-dubbing-clone-v1 --input-url ../assets/videos/dub-video.mp4 --src-language zh` | src_language | 请求体含 src_language |
| aud-dubbing-asyncgeneration-03 | --dst-language | `thcli +gen wand/dubbing/async_generation --model wand-dubbing-clone-v1 --input-url ../assets/videos/dub-video.mp4 --dst-language zh` | dst_language | 请求体含 dst_language |
| aud-dubbing-asyncgeneration-04 | 缺 --input-url | `thcli +gen wand/dubbing/async_generation --model wand-dubbing-clone-v1` | 必填校验 | 本地报「--input-url 必填」 |

### wand/minimax-music/generation

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| aud-minimax-music-generation-01 | 最小调用 | `thcli +gen wand/minimax-music/generation --model minimax-music-v3.0 --lyrics '[Verse] 歌词'` | 必填字段 | 请求体含全部必填字段 |
| aud-minimax-music-generation-02 | --prompt | `thcli +gen wand/minimax-music/generation --model minimax-music-v3.0 --lyrics '[Verse] 歌词' --prompt 猫` | prompt | 请求体含 prompt |
| aud-minimax-music-generation-03 | --lyrics | `thcli +gen wand/minimax-music/generation --model minimax-music-v3.0 --lyrics '[Verse] 歌词'` | lyrics | 请求体含 lyrics |
| aud-minimax-music-generation-04 | --lyrics-optimizer | `thcli +gen wand/minimax-music/generation --model minimax-music-v3.0 --lyrics '[Verse] 歌词' --lyrics-optimizer true` | lyrics_optimizer | 请求体含 lyrics_optimizer |
| aud-minimax-music-generation-05 | --is-instrumental | `thcli +gen wand/minimax-music/generation --model minimax-music-v3.0 --lyrics '[Verse] 歌词' --is-instrumental true` | is_instrumental | 请求体含 is_instrumental |
| aud-minimax-music-generation-06 | --output-format | `thcli +gen wand/minimax-music/generation --model minimax-music-v3.0 --lyrics '[Verse] 歌词' --output-format hex` | output_format | 请求体含 output_format |
| aud-minimax-music-generation-07 | --audio-setting | `thcli +gen wand/minimax-music/generation --model minimax-music-v3.0 --lyrics '[Verse] 歌词' --audio-setting '{"sample_rate":16000}'` | audio_setting | 请求体含 audio_setting |
| aud-minimax-music-generation-08 | --aigc-watermark | `thcli +gen wand/minimax-music/generation --model minimax-music-v3.0 --lyrics '[Verse] 歌词' --aigc-watermark true` | aigc_watermark | 请求体含 aigc_watermark |

### wand/mureka-music/generation

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| aud-mureka-music-generation-01 | 最小调用 | `thcli +gen wand/mureka-music/generation --lyrics '[Verse] 歌词'` | 必填字段 | 请求体含全部必填字段 |
| aud-mureka-music-generation-02 | --prompt | `thcli +gen wand/mureka-music/generation --lyrics '[Verse] 歌词' --prompt 猫` | prompt | 请求体含 prompt |
| aud-mureka-music-generation-03 | --gender | `thcli +gen wand/mureka-music/generation --lyrics '[Verse] 歌词' --gender female` | gender | 请求体含 gender |
| aud-mureka-music-generation-04 | --n | `thcli +gen wand/mureka-music/generation --lyrics '[Verse] 歌词' --n 2` | n | 请求体含 n |
| aud-mureka-music-generation-05 | 缺 --lyrics | `thcli +gen wand/mureka-music/generation` | 必填校验 | 本地报「--lyrics 必填」 |

### wand/mureka-music/easy-generation

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| aud-mureka-music-easy-generation-01 | 最小调用 | `thcli +gen wand/mureka-music/easy-generation --prompt 猫` | 必填字段 | 请求体含全部必填字段 |
| aud-mureka-music-easy-generation-02 | --styles | `thcli +gen wand/mureka-music/easy-generation --prompt 猫 --styles '["pop"]'` | styles | 请求体含 styles |
| aud-mureka-music-easy-generation-03 | --n | `thcli +gen wand/mureka-music/easy-generation --prompt 猫 --n 2` | n | 请求体含 n |
| aud-mureka-music-easy-generation-04 | 缺 --prompt | `thcli +gen wand/mureka-music/easy-generation` | 必填校验 | 本地报「--prompt 必填」 |

### wand/mureka-music/instrumental-generation

| ID | 场景 | 命令 | 覆盖 | 预期 |
|---|---|---|---|---|
| aud-mureka-music-instrumental-generation-01 | 最小调用 | `thcli +gen wand/mureka-music/instrumental-generation --prompt 猫` | 必填字段 | 请求体含全部必填字段 |
| aud-mureka-music-instrumental-generation-02 | --n | `thcli +gen wand/mureka-music/instrumental-generation --prompt 猫 --n 2` | n | 请求体含 n |
| aud-mureka-music-instrumental-generation-03 | 缺 --prompt | `thcli +gen wand/mureka-music/instrumental-generation` | 必填校验 | 本地报「--prompt 必填」 |
