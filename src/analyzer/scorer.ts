import { PatternRow } from '../db.js';
import { matchesPattern } from './bytecode.js';
import { codeSizeDiverges, jaccard } from '../utils/selector-pattern.js';

export interface ScoredResult {
  contract:          string;
  xfer_out:          number;
  xfer_in:           number;
  eth_out:           string;
  eth_in:            string;
  tx_count:          number;
  eip7702_delegate?: string;
  proxy_impl?:       string;
  matched_whitelist: string[];
  selectors?:        string[];
  code_size:         number;
  seen_label?:       string;
}

export interface SimilarityGroup<T> {
  id: string;
  kind: 'seen' | 'similar' | 'single';
  label: string;
  members: T[];
}

export interface SimilarityGroupItem {
  code_size: number;
  selectors?: string[];
  seen_label?: string;
}

class UnionFind {
  private readonly parent: number[];
  private readonly rank: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }

  find(x: number): number {
    if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x]);
    return this.parent[x];
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;

    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
    else {
      this.parent[rb] = ra;
      this.rank[ra]++;
    }
  }
}

export function scoreContract(
  contract: string,
  txCount: number,
  xferOut: number,
  xferIn: number,
  ethOut: bigint,
  ethIn: bigint,
  bytecode: string,
  whitelistPatterns: PatternRow[],
  eip7702_delegate?: string,
): ScoredResult {
  const matched: string[] = [];

  for (const p of whitelistPatterns) {
    if (matchesPattern(bytecode, p.hex_pattern, p.pattern_type)) {
      matched.push(p.name);
    }
  }

  return {
    contract,
    xfer_out: xferOut,
    xfer_in: xferIn,
    eth_out: ethOut.toString(),
    eth_in: ethIn.toString(),
    tx_count: txCount,
    code_size: Math.floor(bytecode.length / 2),
    ...(eip7702_delegate ? { eip7702_delegate } : {}),
    matched_whitelist: matched,
  };
}

export function groupBySimilarity<T extends SimilarityGroupItem>(items: T[]): SimilarityGroup<T>[] {
  if (!items.length) return [];

  const seenGroups = new Map<string, T[]>();
  const freshEntries: Array<{ index: number; item: T }> = [];

  items.forEach((item, index) => {
    if (item.seen_label) {
      const list = seenGroups.get(item.seen_label) ?? [];
      list.push(item);
      seenGroups.set(item.seen_label, list);
      return;
    }
    freshEntries.push({ index, item });
  });

  const groups: SimilarityGroup<T>[] = [];
  const seenResultGroups: SimilarityGroup<T>[] = [];

  for (const [label, members] of seenGroups) {
    seenResultGroups.push({
      id: `seen:${label}`,
      kind: 'seen',
      label,
      members,
    });
  }

  if (!freshEntries.length) {
    return seenResultGroups;
  }

  const uf = new UnionFind(freshEntries.length);
  const selectorSets = freshEntries.map(({ item }) =>
    item.selectors?.length ? new Set(item.selectors) : null,
  );

  for (let i = 0; i < freshEntries.length; i++) {
    if (!selectorSets[i]) continue;
    for (let j = i + 1; j < freshEntries.length; j++) {
      if (!selectorSets[j]) continue;
      if (jaccard(selectorSets[i]!, selectorSets[j]!) >= 0.9
          && !codeSizeDiverges(freshEntries[i].item.code_size, freshEntries[j].item.code_size)) {
        uf.union(i, j);
      }
    }
  }

  const clustered = new Map<number, T[]>();
  for (let i = 0; i < freshEntries.length; i++) {
    const root = uf.find(i);
    const list = clustered.get(root) ?? [];
    list.push(freshEntries[i].item);
    clustered.set(root, list);
  }

  const similarClusters: T[][] = [];
  const singles: T[] = [];

  for (const members of clustered.values()) {
    if (members.length > 1) similarClusters.push(members);
    else singles.push(members[0]);
  }

  similarClusters
    .forEach((members, idx) => {
      groups.push({
        id: `similar:${idx + 1}`,
        kind: 'similar',
        label: `Selector-similar group ${idx + 1}`,
        members,
      });
    });

  if (singles.length) {
    groups.push({
      id: 'single:independent',
      kind: 'single',
      label: 'Independent contracts',
      members: singles,
    });
  }

  return [...groups, ...seenResultGroups];
}
