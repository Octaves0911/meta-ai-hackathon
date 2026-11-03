"""Static website bundle: the checks, the zip and the preview. Run: cd apps/ai && INTERNAL_SECRET=x .venv/bin/python -m unittest -v"""
import io
import unittest
import zipfile

import sitebundle as S

INDEX = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pro</title><link rel="stylesheet" href="styles.css"></head><body><header><h1>Pro for teams</h1><p>The quiet alternative.</p><a class="btn" href="#start">Get Pro</a></header><main id="start"><img src="logo.svg" alt="Logo"><a href="about.html">About</a></main></body></html>'
CSS = "body{margin:0;font-family:system-ui,sans-serif;background:#fff}.btn{min-height:48px}@media(min-width:700px){main{display:grid}}"
SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'
ABOUT = INDEX.replace("<h1>Pro for teams</h1>", "<h1>About</h1>")
GOOD = {"index.html": INDEX, "styles.css": CSS, "logo.svg": SVG, "about.html": ABOUT}
COPY = {"headline": "Pro for teams", "cta": "Get Pro"}


def failing(files, copy=COPY):
    return {c.label: c.detail for c in S.check_bundle(files, copy) if not c.ok}


class CheckTest(unittest.TestCase):
    def test_a_good_site_passes_every_check(self):
        cs = S.check_bundle(GOOD, COPY)
        self.assertEqual(len(cs), 7)
        self.assertTrue(all(c.ok for c in cs), [(c.label, c.detail) for c in cs if not c.ok])
        self.assertEqual(S.problems_of(cs), [])

    def test_unsafe_oversized_and_missing_files(self):
        for files, needle in (({"styles.css": CSS}, "index.html is missing"), ({**GOOD, "../evil.html": "x"}, "valid repository path"), ({**GOOD, ".env": "A=1"}, "secret"),
                              ({**GOOD, "photo.png": "x"}, "binary"), ({**GOOD, "tool.py": "x"}, "only .html"), ({**GOOD, "a.txt": "x" * 250_000}, "larger than"),
                              ({**GOOD, **{f"p{i}.html": ABOUT for i in range(12)}}, "at most 12"), ({**GOOD, "bin.txt": "a\0b"}, "not text")):
            self.assertIn(needle, failing(files).get("Files are safe and allowed", ""), needle)

    def test_references_must_resolve(self):
        bad = {**GOOD, "index.html": INDEX.replace("styles.css", "missing.css").replace("about.html", "nowhere.html")}
        d = failing(bad)["Every local file that is referenced exists"]
        self.assertIn("missing.css", d)
        self.assertIn("nowhere.html", d)
        css_ref = {**GOOD, "styles.css": "body{background:url(img/bg.png)}"}
        self.assertIn("img/bg.png", failing(css_ref)["Every local file that is referenced exists"])
        sub = {**GOOD, "docs/page.html": INDEX.replace("styles.css", "../styles.css").replace("logo.svg", "../logo.svg").replace("about.html", "../about.html")}
        self.assertNotIn("Every local file that is referenced exists", failing(sub))

    def test_nothing_is_loaded_from_elsewhere(self):
        for patch, label in ((INDEX.replace('href="styles.css"', 'href="https://cdn.example/x.css"'), "link"), (INDEX.replace("</body>", '<script src="//cdn.example/a.js"></script></body>'), "script"),
                             (INDEX.replace('src="logo.svg"', 'src="https://track.example/p.gif"'), "img"), (INDEX.replace("</body>", '<iframe src="https://x.example"></iframe></body>'), "iframe")):
            self.assertIn("No remote resources are loaded", failing({**GOOD, "index.html": patch}), label)
        for css in ("@import url(https://fonts.example/f.css);", "body{background:url(//cdn.example/b.png)}", "@import 'https://x.example/a.css';"):
            self.assertIn("No remote resources are loaded", failing({**GOOD, "styles.css": css}), css)
        ext_anchor = INDEX.replace('href="about.html"', 'href="https://example.com" rel="noopener"')
        self.assertNotIn("No remote resources are loaded", failing({**GOOD, "index.html": ext_anchor}))  # ordinary outbound links are fine

    def test_accessibility_basics(self):
        for patch, needle in ((INDEX.replace(' lang="en"', ""), "lang"), (INDEX.replace("<title>Pro</title>", ""), "title"), (INDEX.replace("<h1>Pro for teams</h1>", ""), "0 <h1>"),
                              (INDEX.replace("<h1>Pro for teams</h1>", "<h1>A</h1><h1>B</h1>"), "2 <h1>"), (INDEX.replace(' alt="Logo"', ""), "without alt"), (INDEX.replace("Get Pro", ""), "no text")):
            self.assertIn(needle, failing({**GOOD, "index.html": patch}).get("Accessibility basics", ""), needle)
        self.assertNotIn("Accessibility basics", failing({**GOOD, "index.html": INDEX.replace("Get Pro", "").replace('class="btn"', 'class="btn" aria-label="Get Pro"')}))

    def test_responsive_basics(self):
        self.assertIn("viewport", failing({**GOOD, "index.html": INDEX.replace('<meta name="viewport" content="width=device-width, initial-scale=1">', "")})["Responsive layout basics"])
        self.assertIn("fixed width", failing({**GOOD, "styles.css": ".wrap{width:1200px}"})["Responsive layout basics"])
        self.assertNotIn("Responsive layout basics", failing({**GOOD, "styles.css": ".wrap{max-width:1200px;min-width:0}"}))

    def test_the_approved_copy_must_be_on_the_page(self):
        self.assertIn("headline", failing({**GOOD, "index.html": INDEX.replace("Pro for teams", "Something else")})["The approved copy is on the page"])
        self.assertIn("call to action", failing({**GOOD, "index.html": INDEX.replace("Get Pro", "Buy")})["The approved copy is on the page"])
        text_in_css = {**GOOD, "index.html": INDEX.replace("Pro for teams", "X").replace("Get Pro", "Y"), "styles.css": CSS + ".a:after{content:'Pro for teams Get Pro'}"}
        self.assertIn("The approved copy is on the page", failing(text_in_css))   # copy in CSS or scripts is not on the page
        self.assertEqual(len(S.check_bundle(GOOD, None)), 6)                         # no copy to compare with: that check is skipped

    def test_risky_javascript(self):
        for js in ("eval('1')", "new Function('x')", "document.write('x')", "fetch('/api')", "new WebSocket('wss://x')", "navigator.sendBeacon('/x')"):
            self.assertIn("No risky JavaScript", failing({**GOOD, "script.js": js}), js)
        self.assertIn("handler", failing({**GOOD, "index.html": INDEX.replace("<h1>", '<h1 onclick="x()">')})["No risky JavaScript"])
        self.assertIn("noopener", failing({**GOOD, "index.html": INDEX.replace('href="about.html"', 'href="https://e.example" target="_blank"')})["No risky JavaScript"])
        self.assertNotIn("No risky JavaScript", failing({**GOOD, "script.js": "document.querySelector('.btn').addEventListener('click', () => {});"}))

    def test_copy_is_read_from_the_approved_design(self):
        md = "## Copy\n**Headline:** Pro for teams\n\n**Subhead:** x\n\n**Call to action:** Get Pro\n"
        self.assertEqual(S.extract_copy(md), {"headline": "Pro for teams", "cta": "Get Pro"})
        self.assertEqual(S.extract_copy("nothing here"), {})


class OutputTest(unittest.TestCase):
    def test_the_zip_is_deterministic_and_complete(self):
        a, b = S.make_zip(GOOD), S.make_zip(dict(reversed(list(GOOD.items()))))
        self.assertEqual(a, b)
        z = zipfile.ZipFile(io.BytesIO(a))
        self.assertEqual(sorted(z.namelist()), sorted(GOOD))
        self.assertEqual(z.read("styles.css").decode(), CSS)
        self.assertIsNone(z.testzip())
        self.assertTrue(a.startswith(b"PK\x03\x04"))
        self.assertTrue(all(i.date_time == (1980, 1, 1, 0, 0, 0) for i in z.infolist()))

    def test_the_preview_inlines_css_and_can_never_run_anything(self):
        evil = {**GOOD, "index.html": INDEX.replace("</body>", '<script>alert(1)</script></body>').replace("<h1>", '<h1 onclick="x()">')}
        html = S.preview_html(evil)
        self.assertIn("<style>body{margin:0", html)
        self.assertNotIn("<link", html)
        self.assertNotIn("<script", html)
        self.assertNotIn("onclick", html)
        self.assertIn("Pro for teams", html)


if __name__ == "__main__":
    unittest.main()
