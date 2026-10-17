"""Checks a site produced by build_site.py (fixed-data mode) in headless Chromium.

Setup (once):  pip install playwright   then   playwright install chromium
Run:           python test_built_site.py path/to/my_site/index.html [--expect-title "..."]

Prints PASS/FAIL per check. Written for the bundled example (example/site.json); the content checks
use that example's words, so run it on a site built from the example.
Offline? Build with --bundle-libs, or set COLLOMAP_LIBS (see test_site.py)."""
import sys, os, pathlib
try: sys.stdout.reconfigure(encoding="utf-8")
except Exception: pass
from playwright.sync_api import sync_playwright
if len(sys.argv) < 2: sys.exit(__doc__)
HTML = pathlib.Path(sys.argv[1]).resolve(); URL = HTML.as_uri()
SHOTS = pathlib.Path(__file__).resolve().parent / "test_output"; SHOTS.mkdir(exist_ok=True)
res = []
def check(name, cond, detail=""):
    res.append(bool(cond)); print(("PASS  " if cond else "FAIL  ") + name + (("   [%s]" % detail) if detail != "" else ""))
LIBS = os.environ.get("COLLOMAP_LIBS")
def route(r):
    u = r.request.url.lower()
    for k, fn in (("cytoscape", "cytoscape.min.js"), ("papaparse", "papaparse.min.js")):
        if k in u and u.startswith("http"): return r.fulfill(path=os.path.join(LIBS, fn), content_type="application/javascript")
    r.continue_()

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get("PW_CHROMIUM") or None,
                          args=["--no-sandbox"] if hasattr(os, "geteuid") and os.geteuid() == 0 else [])
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    errs, reqs = [], []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.on("request", lambda r: reqs.append(r.url))
    if LIBS: pg.route("**/*", route)
    pg.goto(URL); pg.wait_for_timeout(1500)
    ev = pg.evaluate
    vis = lambda sel: ev("(s)=>{const e=document.querySelector(s);return !!e && getComputedStyle(e).display!=='none' && e.offsetParent!==null}", sel)

    check("data opens by itself (no welcome page)", ev("!document.body.classList.contains('no-data')") and not vis("#welcome"))
    check("upload buttons are not shown", not vis("#header-open") and not vis("#header-sample") and not vis("#welcome-open"))
    check("rename-groups control is not shown", not vis("#label-row") or ev("document.getElementById('accordion-settings').classList.contains('collapsed')"))
    title = ev("document.title"); check("page title uses site + dataset name", "Collomap" in title and "Adverb" in title, title)
    check("group names from settings", ev("document.getElementById('slot1-title').textContent")=="Adverb" and ev("document.getElementById('slot2-title').textContent")=="Final particle")
    check("legend uses the group names", "Adverb" in ev("document.getElementById('legend').textContent") and "Final particle" in ev("document.getElementById('legend').textContent"))
    check("default 'Mutual strength' is active", ev("document.querySelector('#metric-toggle button.active').dataset.v")=="sym")
    check("all words drawn (8 adverbs + 3 particles)", ev("App.cy.nodes().length")==11, ev("App.cy.nodes().length"))
    heads = ev("[...document.querySelectorAll('#filter-panel .filter-group-label,#filter-panel .filter-type-name')].map(e=>e.textContent)")
    check("tags from the spreadsheet became filters", heads == ["Adverb tags","Adverb type","Final particle tags","Particle function","Pair tags","Register"], heads)
    wf = ev("getComputedStyle(document.documentElement).getPropertyValue('--word-font')")
    check("settings: word font reaches the word tags", "Noto Sans CJK TC" in wf and "Noto Sans CJK TC" in ev("getComputedStyle(document.querySelector('.word-tag')).fontFamily"), wf[:50])
    check("settings: interface keeps its own font", ev("getComputedStyle(document.body).fontFamily").startswith("Helvetica"))
    check("settings: graph labels use the word font", "Noto Sans CJK TC" in ev("App.cy.nodes()[0].style('font-family')"))
    check("settings: base font size applied", ev("getComputedStyle(document.body).fontSize")=="15px")
    check("settings: group colours reach the graph", ev("App.cy.nodes().filter(n=>n.data('slot')==='slot1')[0].style('background-color')") in ("rgb(26,100,168)","#1a64a8"))
    check("example sentences loaded (orphan skipped)", ev("[...App.examples.values()].flat().length")==3, ev("[...App.examples.values()].flat().length"))

    pg.click("#word-search"); pg.fill("#word-search", "豈"); pg.press("#word-search", "Enter"); pg.wait_for_timeout(1300)
    check("focusing 豈 lists its partners 哉 and 乎", sorted(ev("[...document.querySelectorAll('#detail-panel tbody tr')].map(r=>r.dataset.word)"))==sorted(["哉","乎"]))
    ev("openPairDetail('豈','哉')"); pg.wait_for_timeout(300)
    h = ev("document.getElementById('pair-modal-body').innerHTML")
    check("pair dialog: Chinese sentence + translation + reference", "豈" in h and "Is he not truly a great man?" in h and "Test 1" in h)
    check("pair dialog: subtitle uses group names", "Adverb + Final particle" in ev("document.getElementById('pair-modal-body').textContent"))
    pg.screenshot(path=str(SHOTS / "built_pair_dialog.png")); pg.keyboard.press("Escape")

    pg.click("#nav-help"); pg.wait_for_timeout(200)
    check("Help shows the 'about' text", "demonstration dataset" in ev("document.getElementById('help-about').textContent") and vis("#help-about"))
    check("Help hides the 'use your own data' instructions", not vis("#help-own-data") and not vis("#dl-template-pairs"))
    pg.keyboard.press("Escape")
    pg.click("#nav-cite"); pg.wait_for_timeout(200)
    c = ev("document.getElementById('cite-block').textContent")
    check("citation filled in from settings (the web address appears once the site is online)", "Lai, Kay. 2026. Adverb" in c and "[Author]" not in c and "[Dataset title]" not in c, c)
    pg.keyboard.press("Escape")
    check("footer shows the licence", "CC BY 4.0" in ev("document.getElementById('footer-license').textContent"))

    ev("""()=>{const dt=new DataTransfer();dt.items.add(new File(['x'],'x.csv'));
        window.dispatchEvent(new DragEvent('dragenter',{dataTransfer:dt,bubbles:true,cancelable:true}))}""")
    check("dragging a file onto the page does nothing", ev("document.getElementById('drop-overlay').hidden"))

    pg.click("#graph-back"); pg.click("#drawer-head"); pg.click("#highlight-btn"); pg.wait_for_timeout(300)
    marks = ev("[...document.querySelectorAll('#highlight-output mark')].map(m=>m.textContent)")
    check("sample passage is pre-filled and its pairs are marked", len(marks)>=4 and "豈" in marks and "哉" in marks, marks)
    pg.screenshot(path=str(SHOTS / "built_overview.png"))
    ext = [u for u in reqs if u.startswith("http")]
    check("page makes no internet requests" if not LIBS else "no requests except the (locally served) libraries", not ext or LIBS, ext[:3])
    check("no JavaScript errors", errs == [], errs)
    b.close()
print("\n%d/%d checks passed" % (sum(res), len(res))); sys.exit(0 if all(res) else 1)
