/** Prompts and transcript formatting shared by guide generation and Q&A. Ported from the desktop
 *  app's src/lib/ai.ts so answers keep the same shape and the same [mm:ss] citation contract. */
import { clock } from './captions';
import type { Segment } from './types';

export function transcriptForModel(segments: Segment[], translation?: (string | null)[], limitChars = 400_000): string {
  const lines = segments.map((s, i) => `[${clock(s.start)}] ${s.text}${translation?.[i] ? ` ｜ ${translation[i]}` : ''}`);
  let text = lines.join('\n');
  if (text.length > limitChars) {
    // Too long for the model: original text only, then hard-trim.
    text = lines.map((l) => l.split(' ｜ ')[0]).join('\n').slice(0, limitChars);
  }
  return text;
}

// i18n-ignore-start (prompts sent to the model)
export function qaSystem(title: string, show: string, transcript: string): string {
  return `你是 SubCast 的节目助手，帮助中文用户理解一期海外播客/视频。
节目：${show}
本期：${title}

下面是本期带时间戳的完整文字稿（可能是自动识别，个别词有误；「｜」后是中文译文）：
<transcript>
${transcript}
</transcript>

回答规则：
- 用简体中文回答，先给结论，再给依据；适度使用小标题和列表。
- 只根据文字稿回答；文字稿没有涉及的，明确说「节目里没有提到」，可以补充常识但要标明。
- 引用原话或观点时附上时间戳，格式严格为 [mm:ss] 或 [h:mm:ss]，例如 [12:34]，方便用户点击跳转；如果是推荐整段精彩对话，可用区间格式 [12:34]-[13:20]。
- 涉及人名、公司、术语时，第一次出现给出中文并保留英文原文。`;
}

export const GUIDE_SYSTEM = '你是 SubCast 的节目助手，为中文听众写导读。只根据用户给出的带时间戳文字稿写作，不要编造文字稿里没有的内容。';

export function guidePrompt(lengthSecs: number): string {
  const len = lengthSecs > 0 ? `（本期总长 ${clock(lengthSecs)}）` : '';
  return `请通读整份带时间戳的文字稿${len}，为这期节目写一份中文导读，帮听众在一分钟内判断这期讲了什么、值不值得听、该听哪几段。

什么算「要点」：
- 具体、有信息量：带数字、案例、人名、产品、亲身经历或明确的判断，换一期节目就说不出来的内容。
- 不算要点：寒暄、自我介绍、广告和赞助口播、人人都知道的常识、主持人的过渡语。
- 观点写清是谁说的（嘉宾名或「主持人」），不要写成「嘉宾认为 AI 很重要」这种空话。
- 后半段和前半段同样重要。长节目的关键内容常在中后段，不要只总结开头。

用 Markdown，严格按下面的结构输出，不要开场白，不要结尾客套：

## 一句话总结
（谁和谁聊了什么，最重要的结论是什么。一句话，不超过 60 字）

## 时间线
（按时间顺序覆盖整期，从开头一直到结尾，划分 6–14 个话题段落，段落长短大致反映实际时长。每段一行，格式严格为：
- [mm:ss] **段落标题**：一两句说清这段的具体内容
时间戳取这段话题开始的那一句；第一段从节目开头开始；最后一段要落在节目最后 15% 以内；超过一小时用 [h:mm:ss]）

## 核心观点
（5–8 条，按信息量和重要性排序，尽量来自不同段落。每条格式：
- **一句话观点**（说话人）：一两句讲清理由、证据或例子 [mm:ss]）

## 值得记住的原话
（3–5 句，挑观点最鲜明或最有画面感的原句，逐字摘自文字稿，不要改写。每句一行，格式：
> 原句（非中文时在后面给中文翻译）· 说话人 [mm:ss]）

## 先听这几段
（2–3 段信息密度最高的片段，适合没时间听完整期的人。每段一行，格式：
- [mm:ss] **片段标题**：为什么值得听，约几分钟）

写完后自查：每个时间戳都必须是文字稿里真实存在的时间，且对应的那几句确实在讲你写的内容；对不上的改正。时间戳格式只用 [mm:ss] 或 [h:mm:ss]，不要写成区间或其他括号。`;
}
// i18n-ignore-end
