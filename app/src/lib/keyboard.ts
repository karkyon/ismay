/** 現在フォーカス中の要素がテキスト入力かどうかを判定する。
 * グローバルなキーボードショートカット(C, J/K等)が入力欄でのタイピングと
 * 衝突しないようにするために使う。 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}
