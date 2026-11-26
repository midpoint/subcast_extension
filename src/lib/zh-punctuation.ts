/** A conservative, local fallback for Chinese subtitles that arrive without punctuation. It is used
 *  when cloud ASR finished but no model is configured for the smarter punctuation pass: it adds a
 *  sentence-ending mark to every cue, and commas before the discourse markers that almost always
 *  start a new clause in spoken Chinese. It never removes or rewrites a character. */

const CJK = /[\u3400-\u9fff]/;
const TERMINAL = /[。！？!?…]$/;
const TRAILING_SEPARATOR = /[，、；：,;:]+$/;

/** Question-shaped openings/closings, used only to choose ？ instead of 。 at the end. */
const QUESTION_START = /^(为什么|怎么|怎样|什么|哪[里个些]?|谁|是不是|有没有|能不能|可不可以|要不要|对不对|好不好)/;
const QUESTION_END = /(吗|呢)$/;

/** Clause-initial discourse markers. Ordered longest-first so the regex prefers the longest match.
 *  `不过` needs a guard: 不过分 / 不过于 / 不过错 are not conjunctions. */
const MARKERS = [
  '也就是说',
  '换句话说',
  '比如说',
  '尤其是',
  '特别是',
  '不过(?![分于错敏])',
  '但是',
  '所以',
  '因为',
  '如果',
  '虽然',
  '可是',
  '而且',
  '其实',
  '另外',
  '当然',
  '然后',
  '首先',
  '其次',
  '最后',
  '总之',
  '同时',
  '接下来',
  '我觉得',
  '你看',
  '你知道',
  '于是',
  '否则',
  '不然',
].join('|');

const MARKER_RE = new RegExp(`([^，。！？；：、,.!?;:\\s])(${MARKERS})`, 'g');

/** Adds punctuation a normal reader expects. Returns the input unchanged for non-Chinese text or
 *  lines that already end in punctuation and contain no clause boundary worth marking. */
export function punctuateZh(text: string): string {
  let out = text.trim();
  if (!out || !CJK.test(out)) return text;

  // A cue that ends in a comma was cut mid-sentence; give it a sentence end instead.
  out = out.replace(TRAILING_SEPARATOR, '');
  if (!TERMINAL.test(out)) out += QUESTION_START.test(out) || QUESTION_END.test(out) ? '？' : '。';

  out = out.replace(MARKER_RE, '$1，$2');
  return out;
}
