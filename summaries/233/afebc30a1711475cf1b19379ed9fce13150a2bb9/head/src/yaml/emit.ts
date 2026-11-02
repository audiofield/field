import { Document, parseDocument, visit, isMap, isSeq, isScalar, type Node, type Pair } from 'yaml';

// Deterministic YAML emission (project-core.md §3.6): schema-defined key
// order, 2-space indent, block style, no anchors/aliases, minimal quoting,
// trailing newline. Comments must survive programmatic edits, which is why
// canonicalization reorders an existing Document instead of rebuilding it.

export interface KeyOrder {
  keys?: string[];
  children?: Record<string, KeyOrder>;
  items?: KeyOrder; // applied to each element of a sequence
  // Applied to every value of a map whose keys the schema does not know —
  // a record like `sends:`, keyed by author-chosen labels. `children`
  // addresses known keys; this addresses all of them.
  entries?: KeyOrder;
  // Musical time arrays are a recorded exception to block style
  // (musical-time.md §1.7): a flow-flagged sequence stays inline —
  // `length: [12]`, not a block item per element. A notes file's rows
  // are the other: a flow-flagged map is one row, `{at: [1], note: C3}`.
  flow?: boolean;
  // Read at the document's root: the width past which a flow collection
  // breaks across lines. 0 never breaks one, so every note of a notes
  // file stays one row however many fields it spells out.
  lineWidth?: number;
}

const STRINGIFY_OPTIONS = {
  indent: 2,
  lineWidth: 80,
  aliasDuplicateObjects: false,
  flowCollectionPadding: false, // `[12, 2]`, not `[ 12, 2 ]`
} as const;

function keyName(pair: Pair): string | undefined {
  // Parsed pairs carry Scalar keys; pairs added via Document.setIn carry
  // plain strings. Both must rank, or programmatic edits end up appended
  // in place instead of in canonical position.
  if (typeof pair.key === 'string') return pair.key;
  return isScalar(pair.key) && typeof pair.key.value === 'string' ? pair.key.value : undefined;
}

function orderNode(node: Node | null, order: KeyOrder | undefined): void {
  if (!order || node == null) return;
  // Applied after clearFlow, so the flag wins over blocks-everywhere.
  if (order.flow && (isSeq(node) || isMap(node)) && node.items.length > 0) node.flow = true;
  if (isMap(node)) {
    const keys = order.keys ?? [];
    const rank = new Map(keys.map((k, i) => [k, i]));
    const indexed = node.items.map((pair, i) => ({ pair, i }));
    indexed.sort((a, b) => {
      const ra = rank.get(keyName(a.pair) ?? '') ?? keys.length + a.i;
      const rb = rank.get(keyName(b.pair) ?? '') ?? keys.length + b.i;
      return ra - rb || a.i - b.i;
    });
    node.items = indexed.map((e) => e.pair);
    for (const pair of node.items) {
      const child = order.children?.[keyName(pair) ?? ''] ?? order.entries;
      if (child) orderNode(pair.value as Node | null, child);
    }
  } else if (isSeq(node) && order.items) {
    for (const item of node.items) orderNode(item as Node | null, order.items);
  }
}

// Block style is canonical (project-core.md §3.6): clear flow flags on all
// non-empty collections so `a: [1, 2]` formats as a block sequence. Empty
// collections keep their inline `[]` / `{}` rendering.
function clearFlow(doc: Document): void {
  const block = (_key: unknown, node: { items: unknown[]; flow?: boolean }) => {
    if (node.items.length > 0) node.flow = false;
    return undefined;
  };
  visit(doc, { Map: block, Seq: block });
}

// Reorder a parsed document in place to canonical key order, keeping
// comments attached to their pairs.
export function canonicalizeDocument(doc: Document, order: KeyOrder): void {
  clearFlow(doc);
  orderNode(doc.contents, order);
}

export function stringifyDocument(doc: Document, order?: KeyOrder): string {
  return doc.toString({ ...STRINGIFY_OPTIONS, lineWidth: order?.lineWidth ?? STRINGIFY_OPTIONS.lineWidth });
}

// Canonical emission of a fresh value (no comments to preserve).
export function stringifyCanonical(value: unknown, order?: KeyOrder): string {
  const doc = new Document(value);
  if (order) canonicalizeDocument(doc, order);
  return stringifyDocument(doc, order);
}

// Anchors and aliases are banned from checked-in files (project-core.md
// §3.6): an alias makes one logical edit mean N textual things, which
// breaks the diffable-YAML contract.
export function hasAnchorsOrAliases(doc: Document): boolean {
  let found = false;
  const flagAnchor = (_key: unknown, node: { anchor?: string | undefined }) => {
    if (node.anchor) {
      found = true;
      return visit.BREAK;
    }
    return undefined;
  };
  visit(doc, {
    Alias: () => {
      found = true;
      return visit.BREAK;
    },
    Scalar: flagAnchor,
    Map: flagAnchor,
    Seq: flagAnchor,
  });
  return found;
}

// Canonical form of existing YAML text: parse, reorder, restringify.
// Comments and blank-line structure survive; formatting becomes canonical.
export function canonicalText(text: string, order: KeyOrder): string {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(doc.errors[0]!.message);
  }
  canonicalizeDocument(doc, order);
  return stringifyDocument(doc, order);
}
