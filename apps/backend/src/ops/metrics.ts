// Tiny Prometheus-format metrics registry (counters, gauges, histograms). No dependencies, low-cardinality labels only.
type Labels = Record<string, string | number>;
const key = (l: Labels) => Object.keys(l).sort().map((k) => `${k}="${String(l[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`).join(',');

export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Metrics {
  private counters = new Map<string, { help: string; values: Map<string, number> }>();
  private histos = new Map<string, { help: string; buckets: number[]; series: Map<string, { counts: number[]; sum: number; count: number }> }>();
  private gauges = new Map<string, { help: string; read: () => number | { labels: Labels; value: number }[] }>();

  inc(name: string, help: string, labels: Labels = {}, by = 1) {
    let c = this.counters.get(name);
    if (!c) this.counters.set(name, (c = { help, values: new Map() }));
    c.values.set(key(labels), (c.values.get(key(labels)) ?? 0) + by);
  }

  observe(name: string, help: string, seconds: number, labels: Labels = {}, buckets = DEFAULT_BUCKETS) {
    let h = this.histos.get(name);
    if (!h) this.histos.set(name, (h = { help, buckets, series: new Map() }));
    const k = key(labels);
    let s = h.series.get(k);
    if (!s) h.series.set(k, (s = { counts: new Array(h.buckets.length).fill(0), sum: 0, count: 0 }));
    h.buckets.forEach((b, i) => { if (seconds <= b) s!.counts[i]++; });
    s.sum += seconds; s.count++;
  }

  gauge(name: string, help: string, read: () => number | { labels: Labels; value: number }[]) { this.gauges.set(name, { help, read }); }

  value(name: string, labels: Labels = {}): number { return this.counters.get(name)?.values.get(key(labels)) ?? 0; }

  render(): string {
    const out: string[] = [];
    const line = (n: string, k: string, v: number) => out.push(`${n}${k ? `{${k}}` : ''} ${v}`);
    for (const [n, c] of this.counters) { out.push(`# HELP ${n} ${c.help}`, `# TYPE ${n} counter`); for (const [k, v] of c.values) line(n, k, v); }
    for (const [n, g] of this.gauges) {
      out.push(`# HELP ${n} ${g.help}`, `# TYPE ${n} gauge`);
      let v: ReturnType<typeof g.read> = 0;
      try { v = g.read(); } catch { continue; }
      if (typeof v === 'number') line(n, '', v); else for (const s of v) line(n, key(s.labels), s.value);
    }
    for (const [n, h] of this.histos) {
      out.push(`# HELP ${n} ${h.help}`, `# TYPE ${n} histogram`);
      for (const [k, s] of h.series) {
        h.buckets.forEach((b, i) => line(`${n}_bucket`, `${k}${k ? ',' : ''}le="${b}"`, s.counts[i]));
        line(`${n}_bucket`, `${k}${k ? ',' : ''}le="+Inf"`, s.count); line(`${n}_sum`, k, s.sum); line(`${n}_count`, k, s.count);
      }
    }
    return out.join('\n') + '\n';
  }
}
