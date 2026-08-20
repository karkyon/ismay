/**
 * [2026-08-20追加] AI候補同士の「文字通りの重複」を、Embedding APIを使わず
 * 安価に検出する。同じメモを誤って複数回保存した場合(全く同一の原文から
 * 複数回抽出された場合)に典型的に発生し、実際にカルキョンさんの画面で
 * 14件中7件が完全な重複という形で観測された。
 *
 * 意味的な近さ(言い回しが違うが同じ内容)はEmbedding(relatedResponsibilities.ts)側で
 * 扱うため、ここでは正規化後の完全一致・部分一致のみを見る安価な一次フィルタとする。
 */

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s　、。・「」『』（）()【】\-—:：]/g, "")
    .trim();
}

/**
 * candidatesの中から、正規化後タイトルが完全一致するものをグループ化し、
 * 各候補IDに対して「自分と同じグループに属する他の候補ID一覧」を返す。
 */
export function findLiteralDuplicateGroups(
  candidates: { id: string; title: string }[],
): Map<string, string[]> {
  const groups = new Map<string, string[]>(); // normalized -> ids
  for (const c of candidates) {
    const key = normalizeTitle(c.title);
    if (!key) continue;
    const arr = groups.get(key) ?? [];
    arr.push(c.id);
    groups.set(key, arr);
  }

  const result = new Map<string, string[]>();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) {
      result.set(
        id,
        ids.filter((other) => other !== id),
      );
    }
  }
  return result;
}
