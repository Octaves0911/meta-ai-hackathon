// Embeddings gateway. EMBEDDING_PROVIDER=fake (default) hashes words locally so the whole stack runs offline;
// =real calls the AI service /embed (docs/01 §3). All vectors are EMBEDDING_DIM long and L2-normalised.
export const EMBEDDING_DIM = 1536;

const STOP = new Set(('a an and are as at be but by for from has have he i in is it its of on or she that the their there they this to was we were what when which who will with you your our us do did does so if then than not no yes can could should would shall may might just also about into over after before').split(' '));

/** Lowercased word tokens without stop-words, with a light plural/"ing"/"ed" stem so "deploying" ~ "deploy". */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, (m, _s, off) => (off >= 3 ? '' : m)));
}

function fnv(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

/** Deterministic bag-of-words embedding: each token (and bigram, at half weight) lands in a signed hash bucket. */
export function fakeEmbed(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  const toks = tokenize(text);
  const add = (t: string, w: number) => {
    const h = fnv(t, 0);
    v[h % EMBEDDING_DIM] += (fnv(t, 7) & 1 ? 1 : -1) * w;
  };
  toks.forEach((t, i) => { add(t, 1); if (i > 0) add(`${toks[i - 1]}_${t}`, 0.5); });
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export interface Embedder { embed(texts: string[]): Promise<number[][]> }

class FakeEmbedder implements Embedder {
  async embed(texts: string[]) { return texts.map(fakeEmbed); }
}

class AiServiceEmbedder implements Embedder {
  constructor(private url: string, private secret: string) {}
  async embed(texts: string[]) {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 64) {
      const res = await fetch(`${this.url}/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-secret': this.secret },
        body: JSON.stringify({ texts: texts.slice(i, i + 64) }),
      });
      if (!res.ok) throw new Error(`embedding service failed (${res.status})`);
      out.push(...((await res.json()) as { vectors: number[][] }).vectors);
    }
    return out;
  }
}

export function createEmbedder(): Embedder {
  if ((process.env.EMBEDDING_PROVIDER ?? 'fake') === 'real') {
    return new AiServiceEmbedder(process.env.AI_URL ?? 'http://localhost:5001', process.env.INTERNAL_SECRET ?? '');
  }
  return new FakeEmbedder();
}

/** Relevance floor before results reach the judge: 0.55 for real embeddings (docs/02 §3); fake vectors score lower. */
export const defaultMinScore = () => Number(process.env.MEMORY_MIN_SCORE ?? ((process.env.EMBEDDING_PROVIDER ?? 'fake') === 'real' ? 0.55 : 0.2));

export const toVector = (v: number[]) => `[${v.map((x) => +x.toFixed(6)).join(',')}]`;
