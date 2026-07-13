# LTX-2.3 ComfyUI Image-to-Video (I2V) 集成参考文档

> **状态**: 调研完成 | **日期**: 2025-07-14 | **模型**: LTX-2.3 (22B) | **来源**: [github.com/Lightricks/LTX-2](https://github.com/Lightricks/LTX-2) + [ComfyUI-LTXVideo](https://github.com/Lightricks/ComfyUI-LTXVideo)

---

## 1. 概述

LTX-2.3 是 Lightricks 发布的 LTX-2 系列最新版本，22B 参数 DiT-based 音视频联合生成模型。原生支持：

- **Text-to-Video (T2V) / Image-to-Video (I2V)** — 单帧图片驱动视频生成
- **同步音视频生成** — 视频+音频一起输出
- **多关键帧条件控制** — 可指定多帧作为参考
- **IC-LoRA 控制模型** — 深度/姿态/边缘/HDR/LipDub/画质增强等
- **两阶段管线** — Stage1 低分辨率生成 → Stage2 2×空间上采样+蒸馏 LoRA 优化
- **最高 4K 分辨率 / 50 FPS**

ComfyUI 已原生集成 LTX-2 核心节点（`comfy/ldm/lightricks`），额外节点通过 `ComfyUI-LTXVideo` 自定义节点包提供。

---

## 2. 硬件要求

| 项目 | 要求 |
|------|------|
| GPU | **CUDA 兼容 GPU，32GB+ VRAM 推荐** |
| 显存优化 | FP8 量化可降低到约 24GB；`--offload cpu` 可进一步压缩 |
| 磁盘 | **100GB+** 空闲空间（模型 ~50GB + 缓存） |
| 系统 | CUDA 12.x、PyTorch ≥ 2.1.2 |
| macOS | MPS 支持（PyTorch 2.3 或 ≥ 2.6），但速度慢，不推荐生产使用 |

**实测参考**：
- H100 (80GB)：蒸馏模型实时生成（HD 视频 10s, 低分辨率预览 3s）
- RTX 4090 (24GB)：FP8 + offload 可行，单次 I2V 约 2-5 分钟
- RTX 4060 (8GB)：仅 2B 蒸馏模型 + Q8 优化可行

**降级方案**：
```bash
# FP8 量化 + CPU offload
PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True python -m ltx_pipelines.ti2vid_two_stages \
    --quantization fp8-cast --offload cpu --checkpoint-path=...

# 使用蒸馏模型（8步采样，无需CFG/STG）
python -m ltx_pipelines.distilled --distilled-checkpoint-path=...
```

---

## 3. 安装方式

### 3.1 方式一：ComfyUI Manager（推荐）

```
1. 打开 ComfyUI
2. 点击 Manager → Install Custom Nodes
3. 搜索 "LTXVideo"
4. 安装 → 重启 ComfyUI
5. 首次使用自动下载所需模型
```

### 3.2 方式二：手动安装

```bash
cd ComfyUI/custom_nodes/
git clone https://github.com/Lightricks/ComfyUI-LTXVideo.git
cd ComfyUI-LTXVideo
pip install -r requirements.txt
# 重启 ComfyUI
```

### 3.3 模型下载

LTX-2.3 需要以下模型，按目录放置：

```bash
# === 1. 主体模型（二选一）→ ComfyUI/models/checkpoints/
# 全量模型（最高质量，VRAM需求大）
wget https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-22b-dev.safetensors

# 蒸馏模型（快速推理，推荐）
wget https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-22b-distilled-1.1.safetensors

# === 2. 文本编码器 → ComfyUI/models/text_encoders/gemma-3-12b-it-qat-q4_0-unquantized/
# 从 HuggingFace 下载全部文件
git clone https://huggingface.co/google/gemma-3-12b-it-qat-q4_0-unquantized \
    ComfyUI/models/text_encoders/gemma-3-12b-it-qat-q4_0-unquantized

# === 3. 空间上采样器（两阶段管线必需）→ ComfyUI/models/latent_upscale_models/
wget https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-spatial-upscaler-x2-1.1.safetensors
wget https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-spatial-upscaler-x1.5-1.0.safetensors

# === 4. 时间上采样器 → ComfyUI/models/latent_upscale_models/
wget https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-temporal-upscaler-x2-1.0.safetensors

# === 5. 蒸馏 LoRA（两阶段管线）→ ComfyUI/models/loras/
wget https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-22b-distilled-lora-384-1.1.safetensors

# === 6. IC-LoRA 控制模型（可选）→ ComfyUI/models/loras/
# 联合控制（深度+边缘）
wget https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control/resolve/main/ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors
# 运动追踪
wget https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Motion-Track-Control/resolve/main/ltx-2.3-22b-ic-lora-motion-track-control-ref0.5.safetensors
# 画质增强
wget https://huggingface.co/Lightricks/LTX-2-19b-IC-LoRA-Detailer/resolve/main/ltx-2-19b-ic-lora-detailer.safetensors
```

**HuggingFace 认证**：模型需要接受使用条款后登录。
```bash
huggingface-cli login  # 使用 READ token
```

---

## 4. I2V Workflow JSON 关键节点分析

### 4.1 单阶段（Single Stage）I2V Workflow

**文件**: `LTX-2.3_T2V_I2V_Single_Stage_Distilled_Full.json`

#### 核心节点链

```
LoadImage → LTXVPreprocess → LTXVImgToVideoConditionOnly
                                   ↓
GemmaAPITextEncode → LTXVConditioning
                                   ↓
CheckpointLoaderSimple ← LoraLoaderModelOnly
    ↓                                  ↓
EmptyLTXVLatentVideo ──→ LTXVConcatAVLatent ←── LTXVEmptyLatentAudio
                                   ↓
RandomNoise → SamplerCustomAdvanced ← KSamplerSelect ← LTXVScheduler
                                   ↓
LTXVSeparateAVLatent → LTXVTiledVAEDecode → CreateVideo → SaveVideo
                     → LTXVAudioVAEDecode → SaveAudio
```

#### 关键节点参数

| 节点 | 参数 | 值 | 说明 |
|------|------|----|------|
| `EmptyLTXVLatentVideo` | width, height, frames, batch | `960, 544, 121, 1` | 视频分辨率+帧数。帧数必须为 `8k+1`（如 121=15×8+1） |
| `EmptyLTXVLatentAudio` | frames, fps, batch | `97, 25, 1` | 音频帧数（略少于视频以适应VAE对齐） |
| `LTXVImgToVideoConditionOnly` | strength, bypass | `0.7, false` | 图片条件强度（0-1），越高越忠于原图 |
| `LTXVConditioning` | conditioning_frames | `24` | 条件帧数量 |
| `GemmaAPITextEncode` | prompt, negative, model, checkpoint | 正向提示词 + 负向提示词 | 使用 Gemma 3 12B 编码 |
| `LTXVScheduler` | **steps, cfg, stg, rescale, skip_step** | **15, 2.05, 0.95, true, 0.1** | ⭐ 核心调度参数 |
| `ManualSigmas` | sigmas | `1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0` | 手动 sigma 调度（9步蒸馏） |
| `KSamplerSelect` | sampler | `euler_ancestral_cfg_pp` | 采样器类型 |
| `MultimodalGuider` | frames | `28` | 多模态引导帧数 |
| `GuiderParameters` (VIDEO) | cfg, stg, rescale, modality, skip | `3, 1, 0.9, 3, 0` | 视频模态引导 |
| `GuiderParameters` (AUDIO) | cfg, stg, rescale, modality, skip | `7, 1, 0.7, 3, 0` | 音频模态引导 |
| `LTXVTiledVAEDecode` | tile_x, tile_y, overlap, ... | `2, 2, 6, false` | 分块VAE解码（降低显存） |
| `CreateVideo` | fps | `30` | 输出帧率 |
| `LoraLoaderModelOnly` | lora_path, strength | `distilled-lora-384-1.1, 0.5` | 蒸馏LoRA强度 |
| `RandomNoise` | seed, mode | `42, 'fixed'` | 随机种子 |
| `LTXVPreprocess` | max_pixels | `18` | 预处理缩放（18=约2MP） |

---

### 4.2 两阶段（Two Stage）I2V Workflow（推荐生产使用）

**文件**: `LTX-2.3_T2V_I2V_Two_Stage_Distilled.json`

Stage 1 与单阶段相同（低分辨率生成），Stage 2 进行空间上采样 + 蒸馏 LoRA 优化。

#### Stage 2 特有节点

| 节点 | 参数 | 值 | 说明 |
|------|------|----|------|
| `LTXVLatentUpsampler` | - | - | 加载空间上采样模型，2×分辨率提升 |
| `LatentUpscaleModelLoader` | model | `ltx-2.3-spatial-upscaler-x2-1.1.safetensors` | 上采样模型 |
| `ManualSigmas` (Stage2) | sigmas | `0.85, 0.725, 0.4219, 0.0` | 第二阶段4步精炼 |
| `KSamplerSelect` (Stage2) | sampler | `euler_cfg_pp` | 第二阶段采样器 |
| `LTXVImgToVideoConditionOnly` (Stage2) | strength | `1.0` | 第二阶段图片条件强度（更高） |
| Note | - | cfg值建议保持接近1 | 官方提示 |

**注意**：两阶段工作流中的 `Note` 节点明确指出 "explore various samplers and cfg values (although we advise them to be kept close to 1)"。

---

## 5. 关键参数速查

### 5.1 分辨率与帧数

| 参数 | 推荐值 | 约束 |
|------|--------|------|
| 分辨率 (width × height) | `960 × 544`（16:9 约540p） | 必须能被 32 整除 |
| 帧数 (frames) | `121`（~5s@24fps 或 ~4s@30fps） | 必须为 `8k+1`（如 9, 17, 25, ..., 121, 257） |
| FPS | `24` 或 `30` | - |

**常用分辨率 / 帧数组合**：
- `768 × 512 × 121` — 快速预览
- `960 × 544 × 121` — 标准质量
- `1216 × 704 × 121` — 高质量（需更多VRAM）
- `1216 × 704 × 257` — 长视频（~10s@24fps，需大量VRAM）

### 5.2 采样参数

| 参数 | 单阶段 | 两阶段 Stage1 | 两阶段 Stage2 |
|------|--------|---------------|---------------|
| 采样步数 | 8-15 | 8-9 (蒸馏) | 4 |
| Sigma 调度 | 手动9步 | 手动9步 | 手动4步 |
| 采样器 | `euler_ancestral_cfg_pp` | `euler_ancestral_cfg_pp` | `euler_cfg_pp` |
| CFG Scale | 2.05 | ~2-3 | ~1（建议接近1） |
| STG Scale | 0.95 | ~1 | - |
| Rescale | 0.1 | ~0.7 | - |

### 5.3 多模态引导参数 (MultiModalGuider)

| 参数 | Video 默认 | Audio 默认 | 说明 |
|------|-----------|-----------|------|
| `cfg_scale` | 3.0 | 7.0 | 文本对齐强度。设 1.0 禁用 |
| `stg_scale` | 1.0 | 1.0 | 时空引导。设 0.0 禁用 |
| `rescale_scale` | 0.9 | 0.7 | 防止过饱和。设 0.0 禁用 |
| `modality_scale` | 3.0 | 3.0 | 音视频一致性。仅视频设 1.0 |
| `stg_blocks` | [29] | [29] | STG 扰动的 Transformer 层 |
| `skip_step` | 0 | 0 | 每N步跳过引导（加速） |

### 5.4 蒸馏 LoRA 强度

| 阶段 | 强度 | 说明 |
|------|------|------|
| Stage1 | 0.5 | 控制蒸馏效果强度 |
| Stage2 | 0.2 | 轻量精炼，保持质量 |
| 纯蒸馏模型（DistilledPipeline） | 0 | 无需LoRA，模型本身就是蒸馏版 |

---

## 6. I2V 完整管线流程

### 6.1 单阶段管线（快速原型）

```
输入图片 → 预处理(缩放) → VAE编码 → 图片条件注入
提示词 → Gemma编码 → 条件嵌入
空视频潜变量 + 空音频潜变量 → 合并AV潜变量
                                            ↓
              随机噪声 + 调度器 + 采样器 → 去噪循环
                                            ↓
                       分离AV潜变量 → VAE解码 → 视频输出
                                   → 音频VAE解码 → 音频输出
```

**适用场景**：快速迭代、低分辨率预览、VRAM不足时

### 6.2 两阶段管线（生产推荐）

```
Stage1: 与单阶段相同（输出低分辨率视频）
                    ↓
Stage2: 空间上采样器(2×) + 蒸馏LoRA(0.2) + 4步去噪精炼
                    ↓
              VAE解码 → 高分辨率视频
```

**适用场景**：最终产出、需要高清输出

---

## 7. Prompt 工程建议

LTX-2.3 的提示词需遵循以下结构（≤ 200词，英文）：

```
1. 开篇一句描述主要动作
2. 详细描述动作和手势
3. 精确描述角色/物体外观
4. 背景和环境细节
5. 镜头角度和运动
6. 光线和颜色
7. 变化或突发事件的描述
```

**示例**：
```
A traditional Japanese tea ceremony takes place in a tatami room as a host carefully prepares matcha.
Soft traditional koto music plays in the background, adding to the serene atmosphere.
The bamboo whisk taps rhythmically against the ceramic bowl while water simmers in an iron kettle.
Guests kneel in formal seiza position, watching in respectful silence.
The host bows and presents the tea bowl, turning it precisely before offering it to the first guest.
```

**负向提示词（Negative Prompt）**：
```
pc game, console game, video game, cartoon, childish, ugly
```

**提示词增强**：设置 `enhance_prompt=True` 可自动优化提示词。

---

## 8. 优化策略

### 8.1 显存优化

| 方法 | 效果 | 命令 |
|------|------|------|
| FP8 量化 | 减半 VRAM | `--quantization fp8-cast` |
| FP8 缩放矩阵乘法 | Hopper+ GPU 最优 | `--quantization fp8-scaled-mm` |
| CPU Offload | 大幅减少VRAM | `--offload cpu` |
| 磁盘 Offload | 极限节省 | `--offload disk` |
| 蒸馏模型（仅8步） | 最快推理 | 使用 `ltx-2.3-22b-distilled-1.1.safetensors` |
| VAE分块解码 | 降低峰值VRAM | tile_x=2, tile_y=2 |
| ComfyUI参数 | 预留显存 | `python -m main --reserve-vram 5` |

### 8.2 速度优化

| 方法 | 说明 |
|------|------|
| 蒸馏模型 | 8步采样（vs 40步全量模型），实时生成级别 |
| `torch.compile` | `--compile mode=reduce-overhead`，启用 CUDA graphs |
| 梯度估计去噪 | 用 20-30 步替代 40 步，保持质量 |
| 跳过阶段间显存清理 | VRAM 充足时跳过更快 |
| Flash Attention 3/4 | H100/B200 专用优化 |

---

## 9. 可用 LoRA 清单

### IC-LoRA（条件控制）

| 名称 | 功能 |
|------|------|
| `Union-Control` | 深度 + 边缘联合控制 |
| `Motion-Track` | 运动轨迹跟踪 |
| `HDR` | 线性 HDR 输出 (ARRI LogC3) |
| `LipDub` | 唇形同步 + 配音 |
| `Pose-Control` | 人体姿态控制 |
| `Detailer` | 画质增强 |
| `Pixel-Spatial-Upscaler` | 生成式空间超分 (2×/4×) |

### Camera LoRA（镜头控制）

| 名称 | 功能 |
|------|------|
| `Dolly-In` | 推镜头 |
| `Dolly-Out` | 拉镜头 |
| `Dolly-Left` | 左移 |
| `Dolly-Right` | 右移 |
| `Jib-Up` | 上升 |
| `Jib-Down` | 下降 |
| `Static` | 固定机位 |

### 特效 LoRA

| 名称 | 功能 |
|------|------|
| `Instant-Shave` | 去除胡须 |
| `Colorization` | 黑白上色 |
| `Cross-Eyed` | 3D立体 |
| `Day-to-Night` | 昼夜转换 |
| `Deblur` | 去模糊 |
| `Decompression` | 去压缩伪影 |
| `In-Outpainting` | 扩图 |
| `Water-Simulation` | 水模拟 |
| `Ingredients` | 食材特效 |

---

## 10. 参考链接

| 资源 | URL |
|------|-----|
| LTX-2 主仓库 | https://github.com/Lightricks/LTX-2 |
| ComfyUI-LTXVideo 节点 | https://github.com/Lightricks/ComfyUI-LTXVideo |
| LTX-2.3 模型 | https://huggingface.co/Lightricks/LTX-2.3 |
| Gemma 文本编码器 | https://huggingface.co/google/gemma-3-12b-it-qat-q4_0-unquantized |
| 官方文档 | https://docs.ltx.video |
| 在线 Demo | https://console.ltx.video/playground |
| 技术报告 | https://arxiv.org/abs/2601.03233 |
| 提示词指南 | https://ltx.io/blog/prompting-guide-for-ltx-2 |

---

## 11. 集成检查清单

在视频管线中集成 LTX-2.3 时，确保：

- [ ] ComfyUI 已安装并可运行
- [ ] `ComfyUI-LTXVideo` 自定义节点已安装
- [ ] 至少一个主体模型（dev 或 distilled）已下载到 `models/checkpoints/`
- [ ] Gemma 3 12B 文本编码器已下载到 `models/text_encoders/`
- [ ] 空间上采样器已下载到 `models/latent_upscale_models/`（两阶段必需）
- [ ] 蒸馏 LoRA 已下载到 `models/loras/`（两阶段必需）
- [ ] 测试 workflow 可正常加载（从 `example_workflows/2.3/` 导入）
- [ ] 输入图片预处理流程就绪（缩放至 960×544 或目标分辨率）
- [ ] 负向提示词模板就绪
- [ ] 输出视频格式/帧率确认（24fps 或 30fps）
