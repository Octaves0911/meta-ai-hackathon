"""Allowlist sanitizer for AI-written HTML mockups (docs/09 §2.4). Nothing in a mockup may run or load anything: the document is REBUILT from
an allowlist of tags and attributes, so scripts, event handlers, remote resources, forms and frames cannot survive. The app shows the result
in a fully sandboxed iframe with a blocking CSP as well; this is the first of those layers."""
import re
from html import escape
from html.parser import HTMLParser

MAX_HTML = 120_000
MAX_DATA_URI = 60_000

TAGS = {
    "html", "head", "body", "title", "style", "header", "footer", "main", "nav", "section", "article", "aside", "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "a", "button", "img", "strong", "em", "b", "i", "small", "br", "hr", "blockquote", "figure", "figcaption", "table", "thead", "tbody", "tr", "th", "td",
    "svg", "g", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "defs", "lineargradient", "radialgradient", "stop", "text", "tspan",
}
VOID = {"br", "hr", "img"}
SVG_TAGS = {"svg", "g", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "defs", "lineargradient", "radialgradient", "stop", "text", "tspan"}
GLOBAL_ATTRS = {"class", "id", "style", "role", "lang", "title", "colspan", "rowspan"}
SVG_ATTRS = {"viewbox", "width", "height", "fill", "stroke", "d", "x", "y", "cx", "cy", "r", "rx", "ry", "points", "transform", "stroke-width", "stroke-linecap", "stroke-linejoin", "opacity",
             "offset", "stop-color", "stop-opacity", "x1", "y1", "x2", "y2", "fill-opacity", "font-size", "font-family", "font-weight", "text-anchor", "xmlns", "preserveaspectratio", "gradientunits"}
IMG_ATTRS = {"alt", "width", "height", "src"}
DROP_WITH_CONTENT = {"script", "noscript", "iframe", "object", "embed", "template", "canvas", "audio", "video", "applet", "frameset", "form", "select", "textarea", "head_script"}
DATA_IMG = re.compile(r"^data:image/(?:png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$", re.I)


def clean_css(css: str) -> str:
    """Inline styles and <style> text: no imports, no remote or non-image urls, no legacy script hooks."""
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    css = re.sub(r"@(?:import|charset|namespace|font-face)[^;{]*(?:;|\{[^}]*\})", "", css, flags=re.I)
    css = re.sub(r"(?:expression|behavior|-moz-binding)\s*[:(][^;}]*", "", css, flags=re.I)

    def url(m: re.Match) -> str:
        inner = m.group(1).strip().strip("'\"")
        return m.group(0) if DATA_IMG.match(inner) and len(inner) <= MAX_DATA_URI else "none"

    css = re.sub(r"url\(\s*([^)]*)\)", url, css, flags=re.I)
    return re.sub(r"</?\s*style[^>]*>", "", css, flags=re.I)  # a style block cannot close itself and inject markup


class _Rebuild(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.stack: list[str] = []
        self.skip = 0           # inside a dropped element
        self.removed: dict[str, int] = {}
        self.in_style = False
        self.seen_html = False

    def _note(self, what: str) -> None:
        self.removed[what] = self.removed.get(what, 0) + 1

    def handle_starttag(self, tag: str, attrs: list) -> None:
        tag = tag.lower()
        if self.skip:
            if tag not in VOID:
                self.skip += 1
            return
        if tag in DROP_WITH_CONTENT:
            self._note(tag)
            if tag not in VOID:
                self.skip = 1
            return
        if tag not in TAGS:
            self._note(tag)   # unknown tag: drop the tag itself, keep its text
            return
        if tag == "html":
            self.seen_html = True
        kept = []
        for name, value in attrs:
            name = (name or "").lower()
            value = value or ""
            if name.startswith("on"):
                self._note("event handler")
                continue
            if name == "style":
                v = clean_css(value)
                if v.strip():
                    kept.append(f'style="{escape(v, quote=True)}"')
            elif name == "href" and tag == "a":
                kept.append('href="#"')   # a mockup never navigates anywhere
            elif name == "src" and tag == "img":
                if DATA_IMG.match(value.strip()) and len(value) <= MAX_DATA_URI:
                    kept.append(f'src="{escape(value.strip(), quote=True)}"')
                else:
                    self._note("remote image")
            elif name in GLOBAL_ATTRS or name.startswith("aria-") or (tag in SVG_TAGS and name in SVG_ATTRS) or (tag == "img" and name in IMG_ATTRS - {"src"}):
                if name == "id" or name == "class":
                    value = re.sub(r"[^\w\- ]", "", value)
                kept.append(f'{name}="{escape(value, quote=True)}"')
            elif name == "href" or name == "src" or name == "xlink:href":
                self._note("link")
        self.out.append(f"<{tag}{(' ' + ' '.join(kept)) if kept else ''}>")
        if tag == "style":
            self.in_style = True
        if tag not in VOID:
            self.stack.append(tag)

    def handle_startendtag(self, tag: str, attrs: list) -> None:
        self.handle_starttag(tag, attrs)
        if tag.lower() not in VOID and not self.skip and self.stack and self.stack[-1] == tag.lower():
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self.skip:
            if tag in DROP_WITH_CONTENT or tag not in VOID:
                self.skip -= 1
            return
        if tag in TAGS and tag not in VOID and tag in self.stack:
            while self.stack:
                t = self.stack.pop()
                self.out.append(f"</{t}>")
                if t == "style":
                    self.in_style = False
                if t == tag:
                    break

    def handle_data(self, data: str) -> None:
        if self.skip:
            return
        self.out.append(clean_css(data) if self.in_style else escape(data, quote=False))

    def handle_comment(self, data: str) -> None:  # comments (including conditional ones) are dropped
        return

    def close_all(self) -> None:
        while self.stack:
            self.out.append(f"</{self.stack.pop()}>")


def sanitize_html(raw: str) -> tuple[str, dict[str, int]]:
    """Returns (clean document, what was removed). Raises ValueError if the input is empty or too large."""
    if not raw or not raw.strip():
        raise ValueError("empty mockup")
    if len(raw) > MAX_HTML:
        raise ValueError(f"mockup is larger than {MAX_HTML // 1000} KB")
    p = _Rebuild()
    p.feed(raw)
    p.close()
    p.close_all()
    body = "".join(p.out)
    if not p.seen_html:
        body = f"<html><body>{body}</body></html>"
    visible = re.sub(r"<style\b.*?</style>|<title\b.*?</title>", "", body, flags=re.S | re.I)
    has_text = bool(re.sub(r"<[^>]+>", "", visible).strip())
    has_structure = bool(re.search(r"<(?:h[1-6]|p|div|section|header|main|article|button|ul|ol|table|img|svg)\b", visible))
    if not (has_text or re.search(r"<(?:img|svg)\b", visible)) or not has_structure:
        raise ValueError("mockup has no visible content")
    return f"<!doctype html>{body}", p.removed
