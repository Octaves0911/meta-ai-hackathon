"""Static website bundle (docs/09 §1.9, §2.5): when an approved web-page design has no repository to be built in, the Code agent delivers a self-contained static site
(plain HTML/CSS, optional tiny JS), as a downloadable zip plus a sandboxed preview. The model writes the files; CODE checks them, zips them and builds the preview.
These are STATIC checks: no browser or sandbox ran, and the result says so."""
import io
import re
import zipfile
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import urlsplit

from patching import EditError, check_path
from safehtml import sanitize_html

MAX_FILES = 12
MAX_BYTES = 200_000
MAX_REPAIRS = 2
ALLOWED_EXT = (".html", ".css", ".js", ".svg", ".json", ".txt", ".md", ".webmanifest")

BUNDLE_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "notes": {"type": "array", "items": {"type": "string"}},
        "files": {"type": "array", "items": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"], "additionalProperties": False}},
    },
    "required": ["summary", "notes", "files"], "additionalProperties": False,
}
BUNDLE_RULES = (
    "You implement an APPROVED web-page design as a complete, production-quality static website. Deliver files: index.html and styles.css (optionally a few more pages, inline SVG, and a small script.js only if the design needs interaction). "
    "Rules: plain HTML and CSS, no framework and no build step; NO external resources of any kind (no CDNs, remote fonts, images, analytics, iframes): system font stacks only; semantic HTML (header, main, sections, footer, exactly one h1 on index.html), "
    "<html lang>, <title>, the viewport meta tag, alt text on images, real text on every button and link; mobile-first and responsive from 375px up, no fixed widths over 900px; follow the approved design's copy, palette, typography and layout exactly "
    "and never add claims, statistics, testimonials or credits that are not in it; relative links only, '#' for destinations that do not exist yet. Output every file in full."
)


@dataclass
class Check:
    label: str
    ok: bool
    detail: str = ""
    warn: bool = False   # a warning does not fail the bundle


# ---------------------------------------------------------------- reading the design for the copy that must appear
def extract_copy(text: str) -> dict[str, str]:
    """The headline and call to action from the approved design brief ('**Headline:** …', '**Call to action:** …')."""
    out = {}
    for key, rx in (("headline", r"\*\*Headline:\*\*\s*(.+)"), ("cta", r"\*\*Call to action:\*\*\s*(.+)")):
        m = re.search(rx, text or "")
        if m:
            out[key] = m.group(1).strip().strip("*").strip()
    return out


# ---------------------------------------------------------------- HTML facts
class _Facts(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.refs: list[tuple[str, str, str]] = []   # (tag, attr, value)
        self.h1 = 0
        self.lang = False
        self.title = False
        self.viewport = False
        self.imgs_no_alt = 0
        self.handlers: list[str] = []
        self.blank_targets: list[dict] = []
        self.empty_interactive = 0
        self.text: list[str] = []
        self._stack: list[list] = []   # open <a>/<button>: [tag, has_text, has_label]
        self._in_script_or_style = False

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        for k in a:
            if k.startswith("on"):
                self.handlers.append(f"{tag} {k}")
        if tag == "html" and a.get("lang", "").strip():
            self.lang = True
        if tag == "title":
            self.title = True
        if tag == "h1":
            self.h1 += 1
        if tag == "meta" and a.get("name", "").lower() == "viewport":
            self.viewport = True
        if tag == "img" and "alt" not in a:
            self.imgs_no_alt += 1
        for attr in ("href", "src", "action", "poster", "data"):
            if attr in a and a[attr].strip():
                self.refs.append((tag, attr, a[attr].strip()))
        if tag == "a" and a.get("target") == "_blank":
            self.blank_targets.append(a)
        if tag in ("a", "button"):
            self._stack.append([tag, False, bool(a.get("aria-label", "").strip() or a.get("title", "").strip())])
        if tag in ("script", "style"):
            self._in_script_or_style = True

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self._in_script_or_style = False
        if tag in ("a", "button") and self._stack:
            _, has_text, has_label = self._stack.pop()
            if not (has_text or has_label):
                self.empty_interactive += 1

    def handle_data(self, data):
        if self._in_script_or_style:
            return
        t = data.strip()
        if t:
            self.text.append(t)
            for item in self._stack:
                item[1] = True


def _facts(html: str) -> _Facts:
    f = _Facts()
    try:
        f.feed(html)
        f.close()
    except Exception:  # noqa: BLE001 - malformed HTML is reported by the checks, not a crash
        pass
    return f


def _remote(url: str) -> bool:
    u = url.strip().lower()
    return u.startswith(("http://", "https://", "//", "ftp:", "data:text/html", "javascript:"))


def _norm(base_dir: str, ref: str) -> str:
    path = urlsplit(ref).path
    parts: list[str] = []
    for seg in (f"{base_dir}/{path}" if base_dir else path).split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if parts:
                parts.pop()
            continue
        parts.append(seg)
    return "/".join(parts)


# ---------------------------------------------------------------- the checks
def validate_paths(files: dict[str, str]) -> list[str]:
    problems = []
    if not files:
        return ["no files were produced"]
    if len(files) > MAX_FILES:
        problems.append(f"at most {MAX_FILES} files are allowed")
    if "index.html" not in files:
        problems.append("index.html is missing")
    total = 0
    for p, c in files.items():
        try:
            check_path(p)
        except EditError as e:
            problems.append(str(e))
            continue
        if not p.lower().endswith(ALLOWED_EXT):
            problems.append(f"{p}: only {', '.join(ALLOWED_EXT)} files are allowed in a site bundle")
        if "\0" in c:
            problems.append(f"{p} is not text")
        total += len(c.encode())
    if total > MAX_BYTES:
        problems.append(f"the site is larger than {MAX_BYTES // 1000} KB")
    return problems


def check_bundle(files: dict[str, str], copy: dict[str, str] | None = None) -> list[Check]:
    checks: list[Check] = []
    path_problems = validate_paths(files)
    checks.append(Check("Files are safe and allowed", not path_problems, "; ".join(path_problems[:4]) or f"{len(files)} files"))
    if path_problems and "index.html" not in files:
        return checks
    pages = {p: _facts(c) for p, c in files.items() if p.lower().endswith(".html")}
    missing: list[str] = []
    remote: list[str] = []
    for p, f in pages.items():
        base = p.rsplit("/", 1)[0] if "/" in p else ""
        for tag, attr, ref in f.refs:
            if tag == "a" and attr == "href":
                if ref.startswith(("#", "mailto:", "tel:")) or _remote(ref):
                    continue
                target = _norm(base, ref)
                if target and target.lower().endswith((".html", ".css", ".js")) and target not in files:
                    missing.append(f"{p} → {ref}")
                continue
            if _remote(ref):
                remote.append(f"{p}: <{tag} {attr}=\"{ref[:60]}\">")
            elif not ref.startswith(("#", "data:image/")):
                if _norm(base, ref) not in files:
                    missing.append(f"{p} → {ref}")
    for p, c in files.items():
        if p.lower().endswith(".css"):
            for m in re.finditer(r"@import\s+(?:url\()?\s*['\"]?([^'\")\s;]+)|url\(\s*['\"]?([^'\")\s]+)", c, re.I):
                ref = (m.group(1) or m.group(2) or "").strip()
                if ref and _remote(ref):
                    remote.append(f"{p}: {ref[:60]}")
                elif ref and not ref.startswith("data:image/") and _norm(p.rsplit("/", 1)[0] if "/" in p else "", ref) not in files and not _remote(ref):
                    missing.append(f"{p} → {ref}")
    checks.append(Check("Every local file that is referenced exists", not missing, "; ".join(missing[:5]) or "all references resolve"))
    checks.append(Check("No remote resources are loaded", not remote, "; ".join(remote[:5]) or "nothing is fetched from elsewhere"))

    idx = pages.get("index.html") or _Facts()
    a11y = []
    if not idx.lang:
        a11y.append("<html> has no lang attribute")
    if not idx.title:
        a11y.append("no <title>")
    if idx.h1 != 1:
        a11y.append(f"index.html has {idx.h1} <h1> elements (needs exactly one)")
    for p, f in pages.items():
        if f.imgs_no_alt:
            a11y.append(f"{p}: {f.imgs_no_alt} image(s) without alt text")
        if f.empty_interactive:
            a11y.append(f"{p}: {f.empty_interactive} button(s) or link(s) with no text")
    checks.append(Check("Accessibility basics", not a11y, "; ".join(a11y[:5]) or "lang, title, one h1, alt text, labelled controls"))

    wide = [p for p, c in files.items() if p.endswith((".css", ".html")) and re.search(r"(?<![-\w])(?:min-)?width\s*:\s*\d{4,}px", c, re.I)]
    resp = []
    if not idx.viewport:
        resp.append("no viewport meta tag")
    if wide:
        resp.append(f"fixed width of 1000px or more in {', '.join(wide[:3])}")
    checks.append(Check("Responsive layout basics", not resp, "; ".join(resp) or "viewport set, no fixed wide layouts"))

    if copy:
        text = " ".join(idx.text).lower()
        text = re.sub(r"\s+", " ", text)
        absent = [f"{ {'cta': 'call to action'}.get(k, k)} “{v}”" for k, v in copy.items() if re.sub(r"\s+", " ", v.lower()) not in text]
        checks.append(Check("The approved copy is on the page", not absent, ("missing: " + "; ".join(absent)) if absent else "headline and call to action found"))

    risky = []
    for p, f in pages.items():
        risky += [f"{p}: inline handler {h}" for h in f.handlers[:3]]
        risky += [f"{p}: target=_blank link without rel=noopener" for a in f.blank_targets if "noopener" not in a.get("rel", "").lower()][:2]
    for p, c in files.items():
        if p.endswith(".js") or p.endswith(".html"):
            for pat, why in ((r"\beval\s*\(", "eval"), (r"new\s+Function\s*\(", "new Function"), (r"document\.write\s*\(", "document.write"), (r"\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon|WebSocket", "network calls")):
                if re.search(pat, c):
                    risky.append(f"{p}: {why}")
    checks.append(Check("No risky JavaScript", not risky, "; ".join(risky[:5]) or "no inline handlers, eval or network calls"))
    return checks


def problems_of(checks: list[Check]) -> list[str]:
    return [f"{c.label}: {c.detail}" for c in checks if not c.ok and not c.warn]


# ---------------------------------------------------------------- outputs
def make_zip(files: dict[str, str]) -> bytes:
    """Deterministic zip: sorted names, fixed timestamps, no extra attributes."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(files):
            info = zipfile.ZipInfo(p, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, files[p].encode("utf-8"))
    return buf.getvalue()


def preview_html(files: dict[str, str]) -> str:
    """index.html with its stylesheets inlined and scripts removed (by the sanitizer), safe to show in the sandboxed viewer."""
    html = files.get("index.html", "")

    def inline(m: re.Match) -> str:
        href = re.search(r"href\s*=\s*['\"]([^'\"]+)['\"]", m.group(0), re.I)
        css = files.get(_norm("", href.group(1))) if href else None
        return f"<style>{css}</style>" if css is not None else ""

    html = re.sub(r"<link\b[^>]*rel\s*=\s*['\"]?stylesheet['\"]?[^>]*>", inline, html, flags=re.I)
    return sanitize_html(html)[0]
