"""실제 Facebook DYI(JSON) 내보내기 구조를 흉내낸 샘플 ZIP 생성기."""
import json, zipfile, os, struct, zlib, sys, random

OUT = sys.argv[1] if len(sys.argv) > 1 else "sample_export.zip"

def fb_escape(s):
    """FB 내보내기의 특징: UTF-8 바이트를 latin-1 코드포인트로 넣어둔다."""
    return s.encode("utf-8").decode("latin-1")

def png(w, h, rgb):
    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))

TEXTS = [
    "봄이 왔다고 하기엔 아직 이른 바람이 부는 저녁.\n\n퇴근길에 골목 어귀 목련이 봉오리를 맺은 걸 봤다. 매년 지나치던 나무인데 올해는 왜인지 한참을 서서 봤다. 나무는 매년 같은 자리에서 같은 일을 하는데, 그걸 알아보는 마음만 해마다 달라진다.",
    "오늘 아이가 처음으로 자전거를 혼자 탔다. 뒤에서 잡고 있던 손을 놓은 줄도 모르고 한참을 달려가더니, 뒤를 돌아보고는 그제야 놀라서 넘어졌다. 울면서도 다시 타겠다고 했다.",
    "주말에 다녀온 강릉. 파도가 생각보다 높았고, 커피는 생각보다 진했다.",
    "긴 글 테스트. " + ("문장이 페이지 경계를 넘어갈 때 제대로 잘리는지 확인하기 위한 문단입니다. " * 40),
    "짧은 메모.",
    "Mixed English and 한글 test — quotes \"like this\" & ampersands <tags>.",
]

posts = []
ts = 1520000000
for i, t in enumerate(TEXTS):
    p = {"timestamp": ts + i * 86400 * 37, "data": [{"post": fb_escape(t)}]}
    if i in (1, 2, 3):
        p["attachments"] = [{"data": [{"media": {
            "uri": "your_facebook_activity/posts/media/photo_%d.png" % i,
            "creation_timestamp": ts + i * 86400 * 37,
            "description": fb_escape("사진 설명 %d — 캡션 한글" % i),
        }}]}]
    if i == 2:
        p.setdefault("attachments", []).append({"data": [{"place": {
            "name": fb_escape("강릉 안목해변"), "address": fb_escape("강원 강릉시")}}]})
    if i == 5:
        p.setdefault("attachments", []).append({"data": [{"external_context": {
            "url": "https://example.com/x", "name": fb_escape("링크 제목")}}]})
    p["title"] = fb_escape("홍길동님이 게시물을 공유했습니다.")
    posts.append(p)

def photo(n, desc, title=""):
    """앨범/미사용 사진 JSON 안의 사진 항목 (게시물과 형태가 다르다)."""
    p = {"uri": "your_facebook_activity/posts/media/photo_%d.png" % n,
         "creation_timestamp": ts + n * 86400 * 11,
         "media_metadata": {"photo_metadata": {"exif_data": [{"upload_ip": "0.0.0.0"}]}},
         "description": fb_escape(desc)}
    if title:
        p["title"] = fb_escape(title)
    return p

# 앨범 JSON — 사진이 게시물 파일이 아니라 여기 들어 있는 경우가 많다
album = {
    "name": fb_escape("여행 사진첩"),
    "photos": [photo(4, "속초에서 본 일출."), photo(5, "돌아오는 길."),
               photo(2, "강릉 안목해변 파도.")],  # photo_2 는 게시물에도 붙어 있음 (중복 제거 확인용)
    "cover_photo": photo(4, ""),
    "last_modified_timestamp": ts,
    "description": "",
}
# 앨범에 속하지 않는 사진
uncategorized = {"other_photos_v2": [photo(6, "고양이."), photo(7, "")]}
# ZIP 안에 파일이 없는 사진 (내보내기가 여러 개로 쪼개진 상황 재현)
missing = {"other_photos_v2": [{"uri": "your_facebook_activity/posts/media/not_in_zip.png",
                               "creation_timestamp": ts, "description": fb_escape("빠진 사진.")}]}

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    base = "facebook-testuser-2026/your_facebook_activity/posts/"
    # 게시물이 여러 파일로 나뉜 경우까지 재현
    z.writestr(base + "your_posts__check_ins__photos_and_videos_1.json",
               json.dumps(posts[:4], ensure_ascii=False).encode("latin-1", "replace"))
    z.writestr(base + "your_posts__check_ins__photos_and_videos_2.json",
               json.dumps(posts[4:], ensure_ascii=False).encode("latin-1", "replace"))
    z.writestr(base + "album/0.json", json.dumps(album, ensure_ascii=False).encode("latin-1", "replace"))
    z.writestr(base + "your_uncategorized_photos.json",
               json.dumps(uncategorized, ensure_ascii=False).encode("latin-1", "replace"))
    z.writestr(base + "your_photos_missing.json",
               json.dumps(missing, ensure_ascii=False).encode("latin-1", "replace"))
    for i, c in ((1, (220, 90, 80)), (2, (70, 130, 200)), (3, (120, 180, 110)),
                 (4, (240, 170, 60)), (5, (150, 110, 190)), (6, (90, 190, 180)), (7, (200, 200, 90))):
        z.writestr(base + "media/photo_%d.png" % i, png(400, 260 + i * 20, c))
    z.writestr("facebook-testuser-2026/your_facebook_activity/comments/comments.json",
               json.dumps({"comments_v2": []}).encode())
print("wrote", OUT, os.path.getsize(OUT), "bytes")
