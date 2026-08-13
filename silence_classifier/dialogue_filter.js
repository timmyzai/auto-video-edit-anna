// Content-aware safety net for classify.js: turns a cleaned (Simplified
// Chinese, ChatGPT-normalized) raw-timeline dialogue SRT into extra "worth
// keeping" spans, so a quiet-but-meaningful phrase that falls under the
// amplitude/VAD threshold doesn't get cut. See CLAUDE.md's "Autonomous
// rough-cut workflow" and subtitles/PIPELINE_PLAN.md for the full rationale.
//
// Deliberately additive-only: this module only ever identifies spans to KEEP,
// never spans to cut. A false "this is just filler" call would silently
// discard real content - exactly the failure mode this feature exists to
// prevent - so isMeaningfulCue's filler check is a narrow, literal denylist
// of classic non-lexical interjections, not an attempt at general "is this
// meaningful" judgment, and defaults to true (meaningful) whenever unsure.
import { findPieceIndex } from "../lib/timeline.js";

const PUNCTUATION_RE = /[，。！？、,.!?…—\-""''()（）]/g;

// Bare Chinese filler/hesitation/reaction sounds. Intentionally short - only
// tokens that carry no lexical (factual/narrative) content on their own, as
// opposed to real single-character words like 对/好/是/系/有/我/他 ("right",
// "OK", "yes", "have", "I", "he") which stay meaningful regardless of length
// (see isMeaningfulCue's own header). Includes pure emotional-reaction
// exclamations (哇 "wow", 哼 "hmph", 喂 as an attention-getter, 吓/哟 as
// Cantonese filler/exclamation particles) alongside the classic non-lexical
// interjections - confirmed against real transcript review that these read
// as disposable the same way 啊/哦/嗯 do, expressing tone/reaction rather
// than content. Safe to strip as bare substrings since CJK text has no word
// boundaries to lose: a cue like "啊我知道了" ("ah, I get it") still has real
// content after stripping "啊" and correctly stays meaningful (see
// isMeaningfulCue: the check is "does anything remain after removing filler
// tokens", not "does this cue contain a filler token anywhere") - so is
// "哎哟" ("ouch/oh no"), stripped via 哎 then 哟 leaving nothing.
// 欸/誒 added alongside 诶 (same "hey/oh" sound, different Unicode variants
// commonly produced by different auto-caption/ChatGPT-cleanup passes for the
// identical spoken sound) and 嗷 (pain/surprise "ow") - not yet confirmed
// against a real transcript the way the rest of this list was, but same
// category (bare non-lexical reaction sound, not a content word or
// grammatical particle) so same reasoning applies. Deliberately NOT adding
// Cantonese sentence-final particles (咯/嘅/嘛/呢/㗎/喇/咩/咁/唔 etc.) even
// though they're extremely common - those attach to and modify a content
// word rather than standing alone as a bare reaction, and several double as
// real content on their own (唔 = "not", 咩 = "what?", 咁 = "so/like that") -
// stripping them risks silently eating real grammar/content, exactly what
// this narrow-denylist design exists to avoid. Also deliberately NOT adding
// 呵 (a soft "heh" chuckle) - treated the same as 哈哈 elsewhere in this
// project's workflow: authentic laughter is a reaction worth keeping, not
// disposable filler, and that call should stay consistent here.
const CJK_FILLER_CHARS = ["啊", "嗯", "哦", "呃", "哎", "唉", "诶", "欸", "誒", "噢", "喔", "呀", "哇", "哼", "喂", "吓", "哟", "呦", "咦", "嗷"];

// Romanized English filler/hesitation sounds. Matched on word boundaries
// (\b), NOT as bare substrings - stripping "uh" as a substring would eat the
// "uh" out of "huh" too (e.g. "uh huh" -> "uhhuh" -> strip "uh" twice ->
// stray leftover "h"), which then looked like real English content and
// wrongly forced the cue to be kept. Word-boundary matching only strips the
// filler word itself, leaving genuine words like "huh" intact. "ah"/"oh"/
// "eh" included despite being common English words in other contexts (e.g.
// "ah, I see") precisely because as a BARE standalone cue they're always the
// non-lexical reaction reading, never a sentence needing that word - same
// logic as "hmm"/"huh"/"hm" (hesitation/questioning sounds, not content).
const LATIN_FILLER_WORDS = ["um", "uh", "erm", "hmm", "hm", "huh", "ah", "oh", "eh"];

/** True unless `text` is empty/pure-filler after stripping punctuation and
 * known filler tokens. Defaults to true (meaningful) on anything ambiguous.
 *
 * Deliberately has NO length-based cutoff: an earlier version treated any
 * cue under 2 stripped characters as filler regardless of content, which
 * silently misclassified real single-character Chinese/Cantonese words
 * (对/好/是/系/有/我/他/讲/行/噉/啱 - "right", "OK", "yes", "have", "I",
 * "he", "speak", and so on) as filler purely for being short - Chinese has
 * far more meaningful monosyllabic words than English does, so a length
 * cutoff that might work for English text doesn't transfer. Confirmed
 * concretely against a real transcript: "炸" (from 煎炸, "to fry") turned up
 * classified as filler only because ASR cue-splitting had isolated it as its
 * own single-character cue - the length rule would have flagged half of a
 * real word for removal. Now a character only counts as filler if it's
 * actually in CJK_FILLER_CHARS (a known non-lexical interjection sound),
 * exactly like the English-content rule below already works - "kept
 * regardless of length" is the correct default, not the exception. */
export function isMeaningfulCue(text) {
  let remainder = text.replace(PUNCTUATION_RE, "");
  for (const word of LATIN_FILLER_WORDS) {
    remainder = remainder.replace(new RegExp(`\\b${word}\\b`, "gi"), "");
  }
  for (const ch of CJK_FILLER_CHARS) {
    remainder = remainder.split(ch).join("");
  }
  remainder = remainder.replace(/\s+/g, "");
  return remainder.length > 0;
}

/**
 * dialogueCues: [{start, end, text}] on the RAW (pre-cut) timeline, as
 * exported by Jianying's auto-caption and cleaned via ChatGPT.
 * rawTimeline: the raw track's ordered segment layout - [{sourceClip,
 *   sourceStart, sourceEnd, timelineStart, timelineEnd}] - as printed by
 *   jianying/list_draft_sources.js. Same shape as lib/timeline.js's
 *   buildPieceBounds() output, so findPieceIndex works unchanged against it.
 *
 * Returns a flat array of meaningful-cue chunks in source-file-relative time:
 * [{sourceClip, sourceStart, sourceEnd, cueIndex}] - `cueIndex` is the index
 * into `dialogueCues`, so a caller that needs the original cue's text (e.g.
 * subtitles/remap_dialogue.js) can look it back up; a caller that only needs
 * "what to keep" (classify.js) can ignore it and group by sourceClip itself.
 * A single cue can produce more than one chunk if it straddles a boundary
 * between two raw-track segments (rare, but not impossible near a cut point
 * in the user's own raw placement) - each chunk is a real, non-overlapping
 * slice of the cue, never assumed to be the whole thing. Non-meaningful cues
 * produce no chunks - they contribute nothing to keep, but (since this is
 * additive-only) also never cause a cut.
 */
export function meaningfulCueSourceSpans(dialogueCues, rawTimeline) {
  const chunks = [];
  dialogueCues.forEach((cue, cueIndex) => {
    if (!isMeaningfulCue(cue.text)) return;
    const startIdx = findPieceIndex(rawTimeline, cue.start);
    const endIdx = findPieceIndex(rawTimeline, Math.max(cue.start, cue.end - 1e-6));
    for (let idx = startIdx; idx <= endIdx; idx++) {
      const seg = rawTimeline[idx];
      const overlapStart = Math.max(cue.start, seg.timelineStart);
      const overlapEnd = Math.min(cue.end, seg.timelineEnd);
      if (overlapEnd <= overlapStart) continue;
      chunks.push({
        sourceClip: seg.sourceClip,
        sourceStart: seg.sourceStart + (overlapStart - seg.timelineStart),
        sourceEnd: seg.sourceStart + (overlapEnd - seg.timelineStart),
        cueIndex,
      });
    }
  });
  return chunks;
}
