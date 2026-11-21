"""Run with python -m pip install playwright && python -m playwright install chromium
and then python kink-antikink/tests/browser.py from the repository root.
"""
from contextlib import contextmanager
from functools import partial
from hashlib import sha256
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from shutil import copyfile
from tempfile import TemporaryDirectory
from threading import Thread

from playwright.sync_api import expect, sync_playwright


SOURCE = Path(__file__).resolve().parents[1]


@contextmanager
def serve(directory):
    handler = partial(SimpleHTTPRequestHandler, directory=str(directory))
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            thread.join()


def seek(page, time):
    page.locator("#timeline").evaluate(
        "(slider, t) => { slider.value = t; slider.dispatchEvent(new Event('input')); }", time
    )


def plots(page):
    images = page.locator("canvas").evaluate_all("(plots) => plots.map(c => c.toDataURL())")
    assert len(images) == 2
    return tuple(sha256(image.encode()).digest() for image in images)


def ready(page):
    expect(page.locator("#play")).to_be_enabled(timeout=90_000)


def exercise(page, url):
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(url)
    page.locator('[data-preset="capture"]').click()
    ready(page)
    seek(page, 0.05)
    early = plots(page)
    seek(page, 300)
    late = plots(page)
    assert all(a != b for a, b in zip(early, late))
    expect(page.locator("#bion-percent")).to_have_text("79,5 %")
    seek(page, 0.05)
    assert plots(page) == early
    page.locator("#restart").click()
    expect(page.locator("#timeline")).to_have_value("0")
    page.locator("#step").click()
    expect(page.locator("#timeline")).to_have_value("0.2")

    page.locator(".parameters > summary").click()
    page.locator("#eta-number").fill("2")
    page.locator("#apply").click()
    ready(page)
    seek(page, 10)
    physical = plots(page)
    expect(page.locator("#time-label")).to_have_text("t = 5")
    page.locator("#units").select_option("normalized")
    expect(page.locator("#time-label")).to_have_text("τ = 10")
    expect(page.locator("#field-label")).to_have_text("u = φ/η")
    normalized = plots(page)
    assert all(a != b for a, b in zip(physical, normalized))
    page.locator("#units").select_option("physical")
    assert plots(page) == physical

    page.evaluate("""() => {
        for (const name of ['capture', 'escape', 'resonance'])
            document.querySelector('[data-preset="' + name + '"]').click();
    }""")
    ready(page)
    expect(page.locator('[data-preset="resonance"]')).to_have_attribute("aria-pressed", "true")
    expect(page.locator("#timeline")).to_have_attribute("max", "140")
    expect(page.locator("#bion-energy")).to_be_hidden()
    page.locator("#play").click()
    page.wait_for_function("document.querySelector('#timeline').valueAsNumber > 0")
    page.locator("#play").click()
    assert not errors, errors
    return early, late, physical, normalized


def main():
    with TemporaryDirectory() as temporary, sync_playwright() as playwright:
        root = Path(temporary)
        for name in ("compact", "full"):
            directory = root / name
            directory.mkdir()
            for filename in ("index.html", "style.css", "app.js", "solver.js", "worker.js"):
                copyfile(SOURCE / filename, directory / filename)
        # Send actual full-grid typed arrays with neither compact-frame property.
        with (root / "full" / "worker.js").open("a", encoding="utf-8") as worker:
            worker.write("\nKinkPhysics.Simulation.prototype.compactSnapshot = "
                         "KinkPhysics.Simulation.prototype.snapshot;\n")

        with serve(root) as origin, playwright.chromium.launch() as browser:
            for width in (1200, 390):
                results = []
                for mode in ("compact", "full", "file"):
                    page = browser.new_page(viewport={"width": width, "height": 844},
                                            has_touch=width == 390,
                                            device_scale_factor=2 if width == 390 else 1)
                    # Verify worker delivery; a silent fallback could mask a broken fixture.
                    page.add_init_script("""window.completedWorkers = 0;
                        window.Worker = class extends Worker {
                            constructor(...args) {
                                super(...args);
                                this.addEventListener('message', e => {
                                    if (e.data.type === 'complete') window.completedWorkers++;
                                });
                            }
                        };""")
                    url = (SOURCE / "index.html").as_uri() if mode == "file" else f"{origin}/{mode}/"
                    results.append(exercise(page, url))
                    completed = page.evaluate("window.completedWorkers")
                    assert completed == 0 if mode == "file" else completed >= 3
                    page.close()
                assert results[0] == results[1] == results[2], f"Canvas mismatch at width {width}"
                print(f"Passed at {width}px: compact worker, full-grid worker, file fallback")


if __name__ == "__main__":
    main()
