import sys, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = sys.argv[1]
OUT = os.path.join(ROOT, 'store')
os.makedirs(OUT, exist_ok=True)
DOCS = os.path.join(ROOT, 'docs')

PINK = (255, 107, 139)
BG = (21, 21, 28)
FONT = '/System/Library/Fonts/Avenir Next.ttc'
def font(size, bold=True):
    return ImageFont.truetype(FONT, size, index=0 if bold else 5)

# ---- icon redrawn as vector-ish at any size ----
def draw_icon(size, pad=0):
    S = 1024
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.19), fill=PINK)
    body = Image.new('L', (S, S), 0)
    bd = ImageDraw.Draw(body)
    bd.rounded_rectangle([int(S*.17), int(S*.62), int(S*.83), int(S*1.2)], radius=int(S*.22), fill=255)
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S-1, S-1], radius=int(S*.19), fill=255)
    from PIL import ImageChops
    body = ImageChops.multiply(body, mask)
    im.paste((255, 255, 255, 255), (0, 0), body)
    cx, cy, r = S // 2, int(S * .375), int(S * .19)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill='white')
    f = font(int(S * .30))
    d.text((cx, cy + int(S*.01)), '?', font=f, fill=PINK, anchor='mm')
    inner = size - 2 * pad
    icon = im.resize((inner, inner), Image.LANCZOS)
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(icon, (pad, pad), icon)
    return out

# store icon: 128x128, artwork 96x96, 16px transparent padding (CWS guideline)
draw_icon(128, pad=16).save(os.path.join(OUT, 'icon-store-128.png'))


# ---- screenshots 1280x800: caption bar + 16:9 frame ----
W, H = 1280, 800
def caption_shot(src, title, sub, name):
    img = Image.open(os.path.join(DOCS, src)).convert('RGB')
    fh = round(W * img.height / img.width)  # ~719
    img = img.resize((W, fh), Image.LANCZOS)
    c = Image.new('RGB', (W, H), BG)
    c.paste(img, (0, H - fh))
    d = ImageDraw.Draw(c)
    top = H - fh
    d.rectangle([0, 0, 6, top], fill=PINK)
    d.text((32, top // 2), title, font=font(34), fill='white', anchor='lm')
    tw = d.textlength(title, font=font(34))
    d.text((32 + tw + 20, top // 2 + 2), sub, font=font(24, False), fill=(170, 170, 185), anchor='lm')
    c.save(os.path.join(OUT, name), quality=95)

caption_shot('banner.jpg', 'Назвали персонажа — видно, кто это', 'фото, имя по-русски, иероглифы, роль', 'screenshot-1-banner.png')
caption_shot('panel.jpg', 'Панель «Кто есть кто»', 'кого уже упоминали в серии, вкл. прошлые сезоны', 'screenshot-2-panel.png')
caption_shot('card.jpg', 'Клик по баннеру — карточка персонажа', 'сэйю, описание, связанные персонажи', 'screenshot-3-card.png')

# popups side by side
c = Image.new('RGB', (W, H), BG)
d = ImageDraw.Draw(c)
ph = 720
def popup(src, crop_h):
    p = Image.open(os.path.join(DOCS, src)).convert('RGB').crop((0, 0, 720, crop_h))
    return p.resize((round(720 * ph / crop_h), ph), Image.LANCZOS)
p1 = popup('popup-episode.png', 1318)
p2 = popup('popup-settings.png', 1365)
x2 = W - 40 - p2.width
x1 = x2 - 28 - p1.width
for p, x in ((p1, x1), (p2, x2)):
    c.paste(p, (x, 40))
    d.rounded_rectangle([x - 1, 39, x + p.width, 40 + ph], radius=14, outline=(50, 50, 62), width=2)
tx = 48
d.rectangle([0, 0, 6, H], fill=PINK)
d.text((tx, 120), 'Всё настраивается', font=font(34), fill='white')
lines = ['Аниме и серия', 'определяются сами —', 'или укажите вручную', '', 'Задержка субтитров', 'подбирается по звуку', '', 'Сами решаете, кого', 'и что показывать']
y = 200
for ln in lines:
    d.text((tx, y), ln, font=font(26, False), fill=(190, 190, 205))
    y += 38
c.save(os.path.join(OUT, 'screenshot-4-popup.png'))

# ---- promo tiles ----
def promo(w, h, name, title_size, sub_size, with_shot=False):
    c = Image.new('RGB', (w, h), BG)
    d = ImageDraw.Draw(c)
    isz = int(h * (.30 if with_shot else .42))
    ix = 60
    if with_shot:
        shot = Image.open(os.path.join(DOCS, 'banner.jpg')).convert('RGB')
        sh = h - 120
        sw = round(shot.width * sh / shot.height)
        shot = shot.resize((sw, sh), Image.LANCZOS)
        sx, sy = w - sw - 60, 60
        m = Image.new('L', (sw, sh), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, sw-1, sh-1], radius=18, fill=255)
        c.paste(shot, (sx, sy), m)
    ic = draw_icon(isz)
    iy = (h - isz) // 2 - int(h * .12) if not with_shot else 60
    if with_shot:
        c.paste(ic, (ix, iy), ic)
        d.text((ix, iy + isz + int(h*.07)), 'Кто это?', font=font(title_size), fill='white')
        ty = iy + isz + int(h*.07) + title_size + 18
        for k, ln in enumerate(['Подсказки персонажей', 'аниме прямо в плеере']):
            d.text((ix, ty + k * (sub_size + 10)), ln, font=font(sub_size, False), fill=(190, 190, 205))
    else:
        c.paste(ic, ((w - isz) // 2, iy), ic)
        d.text((w // 2, iy + isz + int(h*.06)), 'Кто это?', font=font(title_size), fill='white', anchor='mt')
        d.text((w // 2, iy + isz + int(h*.06) + title_size + 6), 'персонажи аниме прямо в плеере', font=font(sub_size, False), fill=(190, 190, 205), anchor='mt')
    c.save(os.path.join(OUT, name))

promo(440, 280, 'promo-small-440x280.png', 34, 18)
promo(1400, 560, 'promo-marquee-1400x560.png', 64, 30, with_shot=True)
print('ok')
