"""The mockup sanitizer is a security boundary: hostile input must never survive. Run: cd apps/ai && INTERNAL_SECRET=x .venv/bin/python -m unittest -v"""
import unittest

from safehtml import MAX_HTML, sanitize_html

GOOD = '<!doctype html><html><head><title>T</title><style>body{margin:0;background:#0f1424;color:#fff}.btn{padding:12px 20px;border-radius:10px}</style></head><body><header><h1 class="hero">Meetings that follow up</h1><p>Sub</p><button class="btn">Start free</button></header></body></html>'


def clean(raw):
    return sanitize_html(raw)[0]


class SanitizeTest(unittest.TestCase):
    def test_a_normal_mockup_survives_intact(self):
        out = clean(GOOD)
        for needle in ("<h1", "Meetings that follow up", "Start free", "background:#0f1424", "<button", "<!doctype html>"):
            self.assertIn(needle, out)

    def test_scripts_and_handlers_cannot_survive(self):
        out, removed = sanitize_html('<html><body><script>alert(1)</script><div onclick="steal()" onmouseover="x()">hi<img src=x onerror="y()"></div><noscript>n</noscript></body></html>')
        for bad in ("script", "alert", "onclick", "onmouseover", "onerror", "steal", "noscript"):
            self.assertNotIn(bad, out)
        self.assertIn("hi", out)
        self.assertGreaterEqual(removed["event handler"], 2)

    def test_frames_embeds_forms_and_inputs_are_dropped_with_their_content(self):
        out = clean('<div>a<iframe src="https://evil.example">inside</iframe><object data="x">o</object><embed src="x"><form action="https://evil.example"><input name="p"><button>go</button></form>b</div>')
        for bad in ("iframe", "evil.example", "object", "embed", "form", "<input", "inside", "action"):
            self.assertNotIn(bad, out)
        self.assertIn("a", out)
        self.assertIn("b", out)

    def test_links_never_navigate_and_remote_images_are_removed(self):
        out = clean('<div><a href="https://evil.example/x" target="_blank">go</a><a href="javascript:alert(1)">j</a><img src="https://evil.example/t.png" alt="t"><img src="data:image/png;base64,iVBORw0KGgo=" alt="ok"></div>')
        self.assertNotIn("evil.example", out)
        self.assertNotIn("javascript", out)
        self.assertEqual(out.count('href="#"'), 2)
        self.assertEqual(out.count("<img"), 2)
        self.assertIn('src="data:image/png;base64,iVBORw0KGgo="', out)
        self.assertEqual(out.count("src="), 1)

    def test_data_html_and_svg_scripts_are_not_images(self):
        out = clean('<div><img src="data:text/html;base64,PHNjcmlwdD4=" alt="x"><svg viewBox="0 0 10 10"><script>alert(1)</script><rect width="5" height="5" onload="x()" fill="#fff"/></svg></div>')
        self.assertNotIn("text/html", out)
        self.assertNotIn("alert", out)
        self.assertNotIn("onload", out)
        self.assertIn("<rect", out)

    def test_css_cannot_load_or_import_anything(self):
        out = clean('<html><head><style>@import url(https://evil.example/a.css); body{background:url(https://evil.example/x.png);color:red;width:expression(alert(1))} .ok{background:url(data:image/png;base64,AAAA)}</style></head><body><div style="background:url(//evil.example/y);color:blue">x</div></body></html>')
        self.assertNotIn("evil.example", out)
        self.assertNotIn("@import", out)
        self.assertNotIn("expression", out)
        self.assertIn("color:red", out)
        self.assertIn("color:blue", out)
        self.assertIn("data:image/png;base64,AAAA", out)

    def test_a_style_block_cannot_break_out_into_markup(self):
        out = clean('<html><body><style>p{color:red}</style><script>x</script><div>ok</div></body></html>')
        self.assertNotIn("<script", out)
        out2 = clean('<style>a{}</style><p><b>x</b></p>')
        self.assertIn("<b>", out2)

    def test_unknown_tags_lose_the_tag_but_keep_the_text_and_comments_are_dropped(self):
        out = clean('<div><blink>hello</blink><!-- <script>x</script> --><marquee>m</marquee></div>')
        self.assertNotIn("blink", out)
        self.assertNotIn("marquee", out)
        self.assertNotIn("<!--", out)
        self.assertIn("hello", out)

    def test_text_is_escaped_and_attribute_values_cannot_inject(self):
        out = clean('<div class="a&quot; onmouseover=&quot;x" id="q&quot;><script>">T &lt;b&gt; &amp; "quotes"</div>')
        self.assertNotIn("onmouseover=", out)
        self.assertNotIn("<script", out)
        self.assertIn("&lt;b&gt;", out)

    def test_malformed_and_unclosed_markup_is_repaired(self):
        out = clean("<div><section><p>open <b>bold")
        self.assertTrue(out.count("<div>") == out.count("</div>") and out.count("<p>") == out.count("</p>"))

    def test_a_fragment_is_wrapped_into_a_document(self):
        self.assertTrue(clean("<div><h1>Hi</h1></div>").startswith("<!doctype html><html><body>"))

    def test_empty_oversized_or_contentless_input_is_refused(self):
        for bad in ("", "   ", "<script>alert(1)</script>", "just text"):
            with self.assertRaises(ValueError, msg=repr(bad)):
                sanitize_html(bad)
        with self.assertRaises(ValueError):
            sanitize_html("<div>" + "x" * MAX_HTML + "</div>")

    def test_ids_and_classes_are_stripped_to_safe_characters(self):
        out = clean('<div class="hero<x>" id="a b;c">x</div>')
        self.assertNotIn("<x>", out)
        self.assertNotIn(";", out.split(">")[0])


if __name__ == "__main__":
    unittest.main()
