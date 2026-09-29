#!/usr/bin/env python3
"""Zaw Gyi Claw Bot — Facebook announcement cover (1080x1080)."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import glob, os

SRC = glob.glob(os.path.expanduser("~/workspace/zawgyi-claw-bot/assets/*.webp"))[0]
FONT = os.path.expanduser("~/workspace/facebook-page-poster/fonts/Padauk-Bold.ttf")
OUT = "/tmp/zawgyi-fb-announce.png"

W = H = 1080
bg = Image.open(SRC).convert("RGB")
# cover-crop to square, keep center
s = min(bg.size)
bg = bg.crop(((bg.width - s) // 2, (bg.height - s) // 2,
              (bg.width + s) // 2, (bg.height + s) // 2)).resize((W, H), Image.LANCZOS)
# darken for text legibility
dark = Image.new("RGB", (W, H), (5, 8, 25))
bg = Image.blend(bg, dark, 0.45)
# top gradient for text zone
grad = Image.new("L", (1, H))
for y in range(H):
    grad.putpixel((0, y), int(200 * max(0, 1 - y / 620)))
grad = grad.resize((W, H))
black = Image.new("RGB", (W, H), (5, 8, 25))
bg = Image.composite(black, bg, grad)

d = ImageDraw.Draw(bg)
f_badge = ImageFont.truetype(FONT, 44)
f_head = ImageFont.truetype(FONT, 58)
f_title = ImageFont.truetype(FONT, 104)
f_sub = ImageFont.truetype(FONT, 46)
f_cta = ImageFont.truetype(FONT, 52)

def center(y, text, font, fill, stroke=0, sw=2):
    d.text((W // 2, y), text, font=font, fill=fill, anchor="ma",
           stroke_width=sw if stroke else 0, stroke_fill=(10, 10, 30) if stroke else None)

# badge
badge = "PRODUCT LAUNCH"
bw = d.textlength(badge, font=f_badge) + 80
d.rounded_rectangle([W/2 - bw/2, 84, W/2 + bw/2, 152], 34, fill=(124, 58, 237))
d.text((W/2, 118), badge, font=f_badge, fill="white", anchor="mm")

center(230, "ကျွန်တော်ကိုယ်တိုင် တည်ဆောက်ထားတဲ့", f_head, "#e2e8f0", stroke=1)
center(470, "Zaw Gyi", f_title, "#f0abfc", stroke=1)
center(590, "Claw Bot", f_title, "#67e8f9", stroke=1)
# divider
d.rounded_rectangle([W/2 - 120, 700, W/2 + 120, 708], 4, fill="#a855f7")
center(780, "မြန်မာလို ပြောတဲ့ AI Assistant", f_sub, "white", stroke=1)
center(850, "Telegram မှာ အခမဲ့ စမ်းသုံးလို့ရပြီ!", f_sub, "#fde68a", stroke=1)

# CTA pill
cta = "@zawgyiclawbot"
cw = d.textlength(cta, font=f_cta) + 90
d.rounded_rectangle([W/2 - cw/2, 930, W/2 + cw/2, 1010], 40, fill=(22, 163, 74))
d.text((W/2, 970), cta, font=f_cta, fill="white", anchor="mm")

bg.save(OUT)
print("saved", OUT, bg.size)
