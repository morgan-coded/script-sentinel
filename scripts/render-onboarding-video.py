#!/usr/bin/env python3
from __future__ import annotations

import math
import os
import shutil
import subprocess
import textwrap
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
VIDEO_DIR = ROOT / "docs" / "video"
TMP_DIR = VIDEO_DIR / ".tmp-onboarding"
OUTPUT = VIDEO_DIR / "onboarding.mp4"
SRT_OUTPUT = VIDEO_DIR / "onboarding.srt"

W, H = 1920, 1080

COLORS = {
    "bg": "#f4f6f8",
    "sidebar": "#e9eef3",
    "ink": "#202428",
    "muted": "#5b6673",
    "subtle": "#778491",
    "line": "#d6dde5",
    "card": "#ffffff",
    "blue": "#005bd3",
    "green": "#0b7a53",
    "yellow": "#8a5a00",
    "red": "#a32b2b",
    "purple": "#5b4bd8",
    "orange": "#b45400",
    "code_bg": "#f7f8fa",
}


@dataclass
class Scene:
    key: str
    title: str
    subtitle: str
    narration: str
    view: str


SCENES = [
    Scene(
        "01-title",
        "Script Sentinel",
        "Read-only migration evidence for Shopify Scripts to Shopify Functions.",
        "This is Script Sentinel for Shopify Plus. In this demo, we use safe sample data to show how a merchant moves from install to the first useful migration result, without writing discounts, deploying Functions, or changing checkout behavior.",
        "title",
    ),
    Scene(
        "02-install",
        "Install and open the embedded app",
        "OAuth lands the merchant in Shopify Admin; Script Sentinel stays read-only.",
        "After install, Shopify opens the embedded app inside Admin. Script Sentinel is Plus-focused and read-only: it asks for the information needed to inventory scripts, create test fixtures, observe Function outcomes, and produce migration evidence.",
        "install",
    ),
    Scene(
        "03-dashboard",
        "Six steps from install to evidence",
        "The dashboard shows honest progress through the migration workflow.",
        "The dashboard is a six-step path: inventory Scripts, generate cart fixtures, run the Migration Risk Audit, discover deployed Functions, capture observed outputs, and run Drift alerts. Each step is based on stored app state, not a fabricated completion badge.",
        "dashboard",
    ),
    Scene(
        "04-scripts",
        "Paste legacy Script source",
        "Shopify does not expose legacy Script Editor source through Admin API.",
        "For legacy Scripts, the merchant pastes Ruby source from Script Editor. Script Sentinel renders it as text, never executes it, and classifies behavior such as discount logic, shipping rules, payment customization, B2B signals, and market conditions.",
        "scripts",
    ),
    Scene(
        "05-fixtures",
        "Generate PII-scrubbed cart fixtures",
        "Standard read orders access covers the last 60 days.",
        "Next, Script Sentinel uses recent order history to build a deduped library of representative carts. The shipped fallback is the last 60 days, and PII such as names, emails, phone numbers, addresses, and customer identifiers is stripped before storage.",
        "fixtures",
    ),
    Scene(
        "06-functions",
        "Discover Functions and capture observed outputs",
        "Discovery is supported; hosted test invocation is not.",
        "Shopify exposes Function metadata, so Script Sentinel can discover deployed Functions. Hosted apps do not get a simple Admin API test invocation endpoint, so output capture uses the honest live-observation model: observe post-deployment order outcomes and tie them back to fixture shapes.",
        "functions",
    ),
    Scene(
        "07-drift",
        "Run a Drift comparison",
        "Compare Script-era baselines against observed Function outputs.",
        "With fixtures and observed outputs in place, the Drift run compares Script-era baselines against Function-era results. Demo data here shows matches, warnings, a critical difference, and missing coverage, so reviewers can see the real result states.",
        "drift",
    ),
    Scene(
        "08-audit",
        "Create the Migration Risk Audit",
        "Paid audit confirmation is handled by Shopify Managed Billing.",
        "For the paid audit, Shopify Managed Billing handles confirmation. After purchase, Script Sentinel assembles Scripts, fixtures, risk scoring, Drift evidence, and readiness notes into a Migration Risk Audit PDF for the merchant, developer, or agency team.",
        "audit",
    ),
    Scene(
        "09-regression",
        "Keep watching after migration",
        "The regression suite tracks recurring Drift and new alerts.",
        "After the first audit, the regression suite keeps the same evidence layer running. It summarizes recurring runs, new critical or warning alerts, and segment counts like B2B or market risk, while still staying read-only against the store.",
        "regression",
    ),
    Scene(
        "10-wrap",
        "Ready for reviewer handoff",
        "A read-only evidence layer for the Scripts-to-Functions migration.",
        "That is Script Sentinel: a read-only evidence layer for Plus teams moving from Shopify Scripts to Shopify Functions. It does not convert Scripts or modify checkout. It helps the team prove parity before checkout Drift reaches customers.",
        "wrap",
    ),
]


def font(size: int, bold: bool = False, mono: bool = False) -> ImageFont.FreeTypeFont:
    candidates = []
    if mono:
        candidates = ["/System/Library/Fonts/SFNSMono.ttf", "/System/Library/Fonts/Menlo.ttc"]
    elif bold:
        candidates = [
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/System/Library/Fonts/HelveticaNeue.ttc",
        ]
    else:
        candidates = [
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/System/Library/Fonts/HelveticaNeue.ttc",
        ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


F = {
    "hero": font(78, bold=True),
    "h1": font(56, bold=True),
    "h2": font(34, bold=True),
    "h3": font(25, bold=True),
    "body": font(27),
    "small": font(21),
    "tiny": font(18),
    "nav": font(24),
    "mono": font(24, mono=True),
    "mono_small": font(20, mono=True),
}


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def draw_text(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int],
    text: str,
    fill: str,
    font_obj: ImageFont.ImageFont,
    max_width: int | None = None,
    line_spacing: int = 8,
) -> int:
    x, y = xy
    if not max_width:
        draw.text((x, y), text, fill=fill, font=font_obj)
        return y + int(draw.textbbox((x, y), text, font=font_obj)[3] - y)

    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        probe = f"{current} {word}".strip()
        if draw.textlength(probe, font=font_obj) <= max_width:
            current = probe
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)

    cursor = y
    for line in lines:
        draw.text((x, cursor), line, fill=fill, font=font_obj)
        bbox = draw.textbbox((x, cursor), line, font=font_obj)
        cursor += bbox[3] - bbox[1] + line_spacing
    return cursor - line_spacing


def rect(draw: ImageDraw.ImageDraw, xy, fill, outline=None, radius=14, width=1):
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)


def badge(draw, x, y, text, fill, fg, outline=None):
    w = int(draw.textlength(text, font=F["small"])) + 28
    rect(draw, (x, y, x + w, y + 38), fill=fill, outline=outline, radius=19)
    draw.text((x + 14, y + 7), text, fill=fg, font=F["small"])
    return x + w + 12


def base_canvas() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGB", (W, H), hex_to_rgb(COLORS["bg"]))
    return img, ImageDraw.Draw(img)


def sidebar(draw: ImageDraw.ImageDraw, active: str):
    draw.rectangle((0, 0, 302, H), fill=COLORS["sidebar"])
    draw.text((52, 58), "Script Sentinel", fill=COLORS["ink"], font=F["h2"])
    items = ["Dashboard", "Scripts", "Fixtures", "Functions", "Drift", "Regression"]
    y = 178
    for item in items:
        if item == active:
            rect(draw, (30, y - 12, 274, y + 48), fill=COLORS["card"], radius=9)
            color = COLORS["ink"]
        else:
            color = COLORS["muted"]
        draw.text((58, y), item, fill=color, font=F["nav"])
        y += 72


def app_frame(title: str, subtitle: str, active: str) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img, draw = base_canvas()
    sidebar(draw, active)
    draw.text((362, 70), title, fill=COLORS["ink"], font=F["h1"])
    draw_text(draw, (364, 145), subtitle, COLORS["muted"], F["body"], max_width=1370)
    return img, draw


def card(draw, x, y, w, h, title=None):
    rect(draw, (x, y, x + w, y + h), fill=COLORS["card"], outline=COLORS["line"], radius=14)
    if title:
        draw.text((x + 34, y + 32), title, fill=COLORS["ink"], font=F["h2"])


def draw_table(draw, x, y, widths, headers, rows):
    cursor = x
    for i, header in enumerate(headers):
        draw.text((cursor, y), header, fill=COLORS["muted"], font=F["small"])
        cursor += widths[i]
    draw.line((x, y + 44, x + sum(widths), y + 44), fill=COLORS["line"], width=2)
    row_y = y + 64
    for row in rows:
        cursor = x
        rect(draw, (x - 12, row_y - 14, x + sum(widths) + 12, row_y + 48), fill="#fbfcfd", outline="#e4e9ef", radius=8)
        for i, cell in enumerate(row):
            color = COLORS["ink"]
            if str(cell).lower() in {"ready", "matched"}:
                color = COLORS["green"]
            elif str(cell).lower() in {"warning", "missing"}:
                color = COLORS["yellow"]
            elif str(cell).lower() in {"critical"}:
                color = COLORS["red"]
            draw.text((cursor, row_y), str(cell), fill=color, font=F["small"])
            cursor += widths[i]
        row_y += 78


def title_scene(scene: Scene) -> Image.Image:
    img, draw = base_canvas()
    draw.rectangle((0, 0, W, H), fill="#eef3f6")
    rect(draw, (96, 92, 300, 296), fill="#0b3d4a", radius=42)
    draw.text((147, 145), "SS", fill="#f5c34b", font=F["hero"])
    draw.text((96, 365), scene.title, fill=COLORS["ink"], font=font(96, bold=True))
    draw_text(draw, (102, 485), scene.subtitle, COLORS["muted"], font(42), max_width=1120, line_spacing=12)
    x = 104
    for text, fg in [
        ("Shopify Plus", COLORS["blue"]),
        ("read-only", COLORS["green"]),
        ("demo data", COLORS["purple"]),
        ("60-day order fallback", COLORS["yellow"]),
    ]:
        x = badge(draw, x, 650, text, "#ffffff", fg, COLORS["line"])
    card(draw, 1260, 138, 510, 705)
    draw.text((1310, 198), "Onboarding path", fill=COLORS["ink"], font=F["h2"])
    steps = [
        "Install",
        "Paste Scripts",
        "Generate fixtures",
        "Observe Functions",
        "Run drift",
        "Export audit PDF",
    ]
    y = 276
    for index, step in enumerate(steps, 1):
        rect(draw, (1310, y, 1360, y + 50), fill="#e8f4ff", radius=25)
        draw.text((1326, y + 11), str(index), fill=COLORS["blue"], font=F["small"])
        draw.text((1380, y + 9), step, fill=COLORS["ink"], font=F["body"])
        y += 84
    return img


def install_scene(scene: Scene) -> Image.Image:
    img, draw = app_frame(scene.title, scene.subtitle, "Dashboard")
    card(draw, 382, 230, 1250, 640, "Shopify OAuth install")
    x = 455
    y = 330
    steps = [
        ("1", "Open Script Sentinel", "Start from the App Store listing or reviewer install link."),
        ("2", "Approve read-only scopes", "No discount, checkout, Function deployment, or customer-facing write scopes."),
        ("3", "Land in Shopify Admin", "The embedded app opens on the Plus-only migration dashboard."),
    ]
    for num, title, desc in steps:
        rect(draw, (x, y, x + 76, y + 76), fill="#e8f4ff", radius=38)
        draw.text((x + 28, y + 20), num, fill=COLORS["blue"], font=F["h3"])
        draw.text((x + 110, y), title, fill=COLORS["ink"], font=F["h2"])
        draw_text(draw, (x + 110, y + 48), desc, COLORS["muted"], F["body"], max_width=870)
        y += 150
    x = 455
    y = 775
    for text, color in [("read_orders", COLORS["blue"]), ("read_discounts", COLORS["green"]), ("read_products", COLORS["purple"]), ("read_customers", COLORS["yellow"])]:
        x = badge(draw, x, y, text, "#f7f8fa", color, COLORS["line"])
    return img


def dashboard_scene(scene: Scene) -> Image.Image:
    img, draw = app_frame(scene.title, scene.subtitle, "Dashboard")
    card(draw, 362, 228, 1320, 700, "Migration checklist")
    steps = [
        ("1", "Inventory your Scripts", "3 scripts inventoried - 3 active", COLORS["green"]),
        ("2", "Generate cart fixtures", "47 fixtures stored from demo data", COLORS["green"]),
        ("3", "Buy + run migration audit", "Active purchase - PDF available", COLORS["green"]),
        ("4", "Discover deployed Functions", "3 Functions discovered", COLORS["green"]),
        ("5", "Capture Function outputs", "42 observed outputs captured", COLORS["green"]),
        ("6", "Run drift alerts", "18 matched - 2 warning - 1 critical - 3 missing", COLORS["yellow"]),
    ]
    y = 318
    for num, title, hint, color in steps:
        rect(draw, (410, y, 462, y + 52), fill="#edf8f2" if color == COLORS["green"] else "#fff5df", radius=26)
        draw.text((428, y + 13), num, fill=color, font=F["small"])
        draw.text((495, y - 2), title, fill=COLORS["ink"], font=F["h3"])
        draw.text((495, y + 33), hint, fill=COLORS["muted"], font=F["small"])
        y += 92
    card(draw, 1220, 318, 395, 270, "Latest drift")
    draw.text((1260, 405), "1", fill=COLORS["red"], font=font(70, bold=True))
    draw.text((1322, 430), "critical", fill=COLORS["muted"], font=F["body"])
    draw.text((1260, 510), "2 warnings", fill=COLORS["yellow"], font=F["body"])
    return img


def scripts_scene(scene: Scene) -> Image.Image:
    img, draw = app_frame(scene.title, scene.subtitle, "Scripts")
    card(draw, 362, 228, 1320, 700, "Legacy script intake")
    draw_text(draw, (410, 305), "Merchant-provided Ruby source is rendered as text and never executed.", COLORS["muted"], F["body"], max_width=980)
    x = 410
    for text, color in [("line item", COLORS["blue"]), ("active", COLORS["green"]), ("B2B logic", COLORS["purple"]), ("needs parity test", COLORS["yellow"])]:
        x = badge(draw, x, 378, text, "#ffffff", color, COLORS["line"])
    rect(draw, (410, 455, 1560, 745), fill=COLORS["code_bg"], outline=COLORS["line"], radius=10)
    code = [
        "# BFCM SAVE10 quantity script",
        "Input.cart.line_items.each do |line_item|",
        "  next unless line_item.quantity > 1",
        "  if Input.cart.discount_code&.code == \"SAVE10\"",
        "    line_item.change_line_price(line_item.line_price * 0.90,",
        "      message: \"Migration parity case\")",
        "  end",
        "end",
    ]
    y = 492
    for line in code:
        draw.text((450, y), line, fill="#303743", font=F["mono"])
        y += 33
    draw.text((410, 802), "Classified as discount + B2B-sensitive because the source references quantity and customer tags in the full sample.", fill=COLORS["muted"], font=F["small"])
    return img


def fixtures_scene(scene: Scene) -> Image.Image:
    img, draw = app_frame(scene.title, scene.subtitle, "Fixtures")
    card(draw, 362, 228, 1320, 700, "PII-stripped fixture library")
    draw_text(draw, (410, 305), "Names, emails, phones, full addresses, and customer identifiers are removed before storage.", COLORS["muted"], F["body"], max_width=1100)
    rows = [
        ("B2B quantity cart", "US", "USD", "company tag", "ready"),
        ("Shipping threshold", "CA", "CAD", "country code", "ready"),
        ("Payment method case", "GB", "GBP", "gateway only", "ready"),
        ("Market pricing case", "AU", "AUD", "market code", "ready"),
        ("SAVE10 discount cart", "US", "USD", "discount code", "ready"),
    ]
    draw_table(draw, 410, 405, [330, 170, 190, 330, 180], ["Scenario", "Market", "Currency", "Signals", "Status"], rows)
    draw.text((410, 830), "Demo library: 47 deduped representative carts from the shipped 60-day order fallback.", fill=COLORS["muted"], font=F["small"])
    return img


def functions_scene(scene: Scene) -> Image.Image:
    img, draw = app_frame(scene.title, scene.subtitle, "Functions")
    card(draw, 362, 228, 1320, 700, "Observed Function outputs")
    draw_text(draw, (410, 305), "Function metadata can be discovered. Output capture is based on post-deployment orders because hosted apps do not get a simple Admin API test-invocation endpoint.", COLORS["muted"], F["body"], max_width=1140)
    rows = [
        ("cart-transform-tiered-pricing", "discount", "2026-04", "18 outputs"),
        ("delivery-customization-market-rates", "shipping", "2026-04", "14 outputs"),
        ("payment-customization-b2b-po", "payment", "2026-04", "10 outputs"),
    ]
    draw_table(draw, 410, 430, [470, 230, 220, 240], ["Function", "Category", "API version", "Captured"], rows)
    card(draw, 410, 760, 1160, 100)
    draw.text((444, 795), "Live-observation fallback:", fill=COLORS["ink"], font=F["h3"])
    draw.text((735, 798), "capture real post-deployment outcomes, then compare against saved fixture baselines.", fill=COLORS["muted"], font=F["small"])
    return img


def drift_scene(scene: Scene) -> Image.Image:
    img, draw = app_frame(scene.title, scene.subtitle, "Drift")
    card(draw, 362, 228, 1320, 700, "Parity comparison run")
    metrics = [("Matched", "18", COLORS["green"]), ("Warnings", "2", COLORS["yellow"]), ("Critical", "1", COLORS["red"]), ("Missing", "3", COLORS["muted"])]
    x = 410
    for label, value, color in metrics:
        rect(draw, (x, 330, x + 230, 465), fill="#fbfcfd", outline=COLORS["line"], radius=10)
        draw.text((x + 30, 360), label, fill=COLORS["muted"], font=F["small"])
        draw.text((x + 30, 398), value, fill=color, font=font(50, bold=True))
        x += 270
    rows = [
        ("SAVE10 discount cart", "discount", "critical", "$10.00 baseline vs $0.00 output"),
        ("B2B quantity cart", "b2b", "warning", "tier threshold differs"),
        ("Payment method case", "payment", "matched", "gateway parity confirmed"),
    ]
    draw_table(draw, 410, 545, [310, 210, 180, 470], ["Fixture", "Category", "Severity", "Finding"], rows)
    return img


def audit_scene(scene: Scene) -> Image.Image:
    img, draw = app_frame(scene.title, scene.subtitle, "Dashboard")
    card(draw, 362, 228, 550, 700, "Audit action")
    draw_text(draw, (410, 310), "Shopify Managed Billing confirms the paid audit before the report is generated.", COLORS["muted"], F["body"], max_width=450)
    rect(draw, (410, 475, 780, 540), fill=COLORS["blue"], radius=10)
    draw.text((445, 493), "Run migration audit", fill="#ffffff", font=F["h3"])
    x = 410
    for text, color in [("test charge in dev store", COLORS["green"]), ("PDF evidence", COLORS["purple"]), ("read-only", COLORS["blue"])]:
        x = badge(draw, x, 600, text, "#f7f8fa", color, COLORS["line"])

    card(draw, 970, 228, 640, 700, "Migration Risk Audit")
    draw.text((1020, 310), "Executive summary", fill=COLORS["ink"], font=F["h2"])
    draw_text(draw, (1020, 370), "3 scripts reviewed across 47 PII-stripped fixtures. One critical discount mismatch needs developer review before rollout.", COLORS["muted"], F["body"], max_width=520)
    draw.line((1020, 510, 1540, 510), fill=COLORS["line"], width=2)
    checks = ["Risk score by Script", "Fixture coverage summary", "Drift evidence", "Migration checklist", "Developer handoff notes"]
    y = 550
    for item in checks:
        draw.text((1020, y), "OK", fill=COLORS["green"], font=F["h3"])
        draw.text((1070, y), item, fill=COLORS["ink"], font=F["body"])
        y += 58
    return img


def regression_scene(scene: Scene) -> Image.Image:
    img, draw = app_frame(scene.title, scene.subtitle, "Regression")
    card(draw, 362, 228, 1320, 700, "Regression suite")
    metrics = [("New critical", "1", COLORS["red"]), ("New warning", "2", COLORS["yellow"]), ("Fixtures examined", "47", COLORS["blue"]), ("B2B critical", "1", COLORS["purple"])]
    x = 410
    for label, value, color in metrics:
        rect(draw, (x, 330, x + 250, 465), fill="#fbfcfd", outline=COLORS["line"], radius=10)
        draw.text((x + 28, 360), label, fill=COLORS["muted"], font=F["small"])
        draw.text((x + 28, 398), value, fill=color, font=font(48, bold=True))
        x += 292
    rows = [
        ("manual", "completed", "47", "1 critical / 2 warning"),
        ("cron", "completed", "47", "0 critical / 1 warning"),
        ("cron", "completed", "44", "0 critical / 0 warning"),
    ]
    draw_table(draw, 410, 555, [240, 260, 230, 430], ["Trigger", "Status", "Fixtures", "Alert summary"], rows)
    return img


def wrap_scene(scene: Scene) -> Image.Image:
    img, draw = base_canvas()
    rect(draw, (96, 96, 1824, 984), fill="#0b3d4a", radius=34)
    draw.text((170, 190), "Script Sentinel", fill="#ffffff", font=font(88, bold=True))
    draw_text(draw, (176, 310), "A read-only evidence layer for the Scripts-to-Functions migration.", "#dcebf0", font(42), max_width=1190, line_spacing=14)
    cards = [
        ("Does", "classify pasted Scripts, generate fixtures, observe Function outputs, compare drift, and export evidence."),
        ("Does not", "convert Scripts, deploy Functions, write discounts, alter checkout, or mutate customer-facing store behavior."),
        ("Reviewer note", "Demo data is used here. Production fixture generation depends on Shopify protected Order-data approval."),
    ]
    x = 176
    y = 560
    for title, body in cards:
        rect(draw, (x, y, x + 500, y + 250), fill="#ffffff", radius=18)
        draw.text((x + 34, y + 34), title, fill=COLORS["ink"], font=F["h2"])
        draw_text(draw, (x + 34, y + 92), body, COLORS["muted"], F["body"], max_width=420)
        x += 548
    return img


RENDERERS = {
    "title": title_scene,
    "install": install_scene,
    "dashboard": dashboard_scene,
    "scripts": scripts_scene,
    "fixtures": fixtures_scene,
    "functions": functions_scene,
    "drift": drift_scene,
    "audit": audit_scene,
    "regression": regression_scene,
    "wrap": wrap_scene,
}


def run(args: list[str], cwd: Path = ROOT) -> str:
    completed = subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=True)
    return completed.stdout.strip()


def duration(path: Path) -> float:
    out = run([
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ])
    return float(out)


def srt_time(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    hours, ms = divmod(ms, 3600_000)
    minutes, ms = divmod(ms, 60_000)
    secs, ms = divmod(ms, 1000)
    return f"{hours:02}:{minutes:02}:{secs:02},{ms:03}"


def write_srt(captions: list[tuple[float, float, str]]):
    lines = []
    for idx, (start, end, text) in enumerate(captions, 1):
        wrapped = "\n".join(textwrap.wrap(text, width=78))
        lines.append(f"{idx}\n{srt_time(start)} --> {srt_time(end)}\n{wrapped}\n")
    SRT_OUTPUT.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise SystemExit("ffmpeg and ffprobe are required")
    if not shutil.which("say"):
        raise SystemExit("macOS say is required for narration")

    if TMP_DIR.exists():
        shutil.rmtree(TMP_DIR)
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    VIDEO_DIR.mkdir(parents=True, exist_ok=True)

    image_entries = []
    audio_entries = []
    captions = []
    cursor = 0.0

    for index, scene in enumerate(SCENES, 1):
        image_path = TMP_DIR / f"{index:02}-{scene.key}.png"
        audio_path = TMP_DIR / f"{index:02}-{scene.key}.aiff"
        text_path = TMP_DIR / f"{index:02}-{scene.key}.txt"

        renderer = RENDERERS[scene.view]
        renderer(scene).save(image_path)
        text_path.write_text(scene.narration, encoding="utf-8")
        run(["say", "-v", "Samantha", "-r", "108", "-f", str(text_path), "-o", str(audio_path)])

        scene_duration = duration(audio_path) + 0.18
        image_entries.append((image_path, scene_duration))
        audio_entries.append(audio_path)
        captions.append((cursor, cursor + scene_duration, scene.narration))
        cursor += scene_duration

    audio_list = TMP_DIR / "audio.txt"
    audio_list.write_text(
        "\n".join(f"file '{str(p).replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'" for p in audio_entries),
        encoding="utf-8",
    )
    narration = TMP_DIR / "narration.aiff"
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(audio_list), "-c", "copy", str(narration)])

    image_list = TMP_DIR / "images.txt"
    lines = []
    for image_path, scene_duration in image_entries:
        escaped = str(image_path).replace("'", "'\\''")
        lines.append(f"file '{escaped}'")
        lines.append(f"duration {scene_duration:.3f}")
    escaped_last = str(image_entries[-1][0]).replace("'", "'\\''")
    lines.append(f"file '{escaped_last}'")
    image_list.write_text("\n".join(lines), encoding="utf-8")

    run([
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(image_list),
        "-i",
        str(narration),
        "-vf",
        "fps=30,format=yuv420p,scale=1920:1080",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "21",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-shortest",
        "-movflags",
        "+faststart",
        str(OUTPUT),
    ])

    write_srt(captions)
    shutil.rmtree(TMP_DIR, ignore_errors=True)
    print(f"Wrote {OUTPUT}")
    print(f"Wrote {SRT_OUTPUT}")
    print(f"Duration: {duration(OUTPUT):.1f}s")


if __name__ == "__main__":
    main()
