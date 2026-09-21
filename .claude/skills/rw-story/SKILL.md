---
name: rw-story
description: Biến một ý tưởng câu chuyện (kèm bối cảnh và ảnh nhân vật có sẵn) thành project nhiều cảnh trong Runway Studio, rồi chạy pipeline sinh ảnh tham chiếu → ảnh khung đầu → clip → ghép video. Dùng khi người dùng đưa một ý tưởng, một cốt truyện, một kịch bản, hoặc yêu cầu làm video dài hơn độ dài một clip.
---

# Biến ý tưởng thành video nhiều cảnh

Người dùng đưa ý tưởng. Việc của bạn: viết ra prompt, tạo project, chạy pipeline.

Mọi thao tác đi qua `node scripts/rw.mjs` — xem `help` để biết lệnh. Đừng gọi
`/api/pipeline/*` bằng curl, CLI đã lo đăng nhập và báo lỗi dễ đọc.

## Trước khi làm gì

```bash
node scripts/rw.mjs whoami     # server sống chưa, có API key chưa
node scripts/rw.mjs credits    # số dư — QUAN TRỌNG, xem mục Chi phí
```

Nếu `whoami` lỗi: người dùng chưa chạy server (`npm start`), hoặc chưa cấu hình
`RW_BASE`/`RW_CODE`. Nói cho họ, đừng tự đoán mã.

## Bước 1 — Hỏi cho đủ, nhưng chỉ hỏi cái thiếu

Cần bốn thứ. Thiếu cái nào thì hỏi cái đó, đừng hỏi lại cái đã có:

| Cần | Nếu người dùng không nói |
|---|---|
| Câu chuyện | Phải hỏi. Không tự bịa cốt truyện. |
| Tổng thời lượng | Mặc định 32s (4 cảnh × 8s) |
| Dọc hay ngang | Mặc định dọc `VERTICAL` (TikTok/Reels) |
| Ảnh nhân vật có sẵn | Không có thì sinh ảnh tham chiếu, tốn thêm credit |

Nếu họ có ảnh người thật / logo thật / sản phẩm thật: **phải dùng `ref_image`**.
Model không vẽ lại được cái đã tồn tại — tả bằng chữ sẽ ra người khác.

## Bước 2 — Viết kịch bản ra một file JSON

Ghi vào một file tạm, ví dụ `story.json`. Định dạng:

```json
{
  "name": "Tên project",
  "story": "Tóm tắt cốt truyện, 2-3 câu. Chỉ để người đọc, không vào prompt.",
  "material": "Pixar-style 3D render, warm morning light, shallow depth of field, soft pastel palette",
  "orientation": "VERTICAL",
  "video": { "title": "Tập 1", "ratio": "720:1280", "model": "gen4_turbo" },
  "entities": [
    {
      "name": "Pippip",
      "entity_type": "character",
      "description": "Chubby orange tabby cat, blue linen apron, small round glasses, white chest fur",
      "voice_description": "Giọng trẻ, hơi rụt rè, tốc độ chậm"
    },
    {
      "name": "Bà Lan",
      "entity_type": "character",
      "ref_image": "./anh/ba-lan.jpg"
    }
  ],
  "scenes": [
    {
      "image_prompt": "@pippip đứng sau @sap_ca, tay lau mặt bàn gỗ, nhìn ra con đường vắng",
      "video_prompt": "0-3s: wide shot, sạp cá trong nắng sớm, bụi bay trong tia nắng. 3-8s: dolly in chậm về phía @pippip",
      "duration": 8,
      "entities": ["Pippip", "Sạp Cá"]
    }
  ]
}
```

Rồi chạy:

```bash
node scripts/rw.mjs plan story.json
```

Lệnh này kiểm tra **hết** trước khi ghi: thiếu trường, thiếu file ảnh, tên thực
thể không khớp — báo hết một lượt và **không tạo gì**. Sửa file rồi chạy lại.

## Luật viết prompt — đọc kỹ, đây là chỗ hay sai nhất

Ba trường prompt đi vào ba lời gọi API khác nhau. Viết lẫn nội dung là ra kết quả sai.

### `material` — phong cách hình ảnh

Nối vào **mọi** ảnh (ảnh tham chiếu và ảnh khung đầu). Đây là thứ giữ style
nhất quán giữa các cảnh. Viết bằng **tiếng Anh**, tả chất liệu/ánh sáng/bảng màu,
**không** tả nội dung.

- Đúng: `Pixar-style 3D render, warm morning light, shallow depth of field, soft pastel palette`
- Sai: `Một chú mèo bán cá ở chợ` ← đây là nội dung, không phải phong cách

Vì `material` tự được nối vào, **đừng nhắc lại phong cách trong từng cảnh**.

### `entities[].description` — CHỈ ngoại hình

Trường này trở thành prompt sinh ảnh tham chiếu. Server tự nối thêm yêu cầu
kỹ thuật theo `entity_type` (toàn thân, nền trơn, chính diện...). Viết bằng
**tiếng Anh**.

- Đúng: `Chubby orange tabby cat, blue linen apron, small round glasses, white chest fur`
- Sai: `Chú mèo đang buồn vì không ai mua cá` ← cảm xúc và hành động thuộc về `image_prompt`

Có `ref_image` thì **bỏ hẳn** `description` — ảnh thật thắng mọi lời tả.

`entity_type` chọn đúng vì nó quyết định khung ảnh tham chiếu:

| type | dùng cho | khung ảnh |
|---|---|---|
| `character` | người, con vật có vai | dọc, toàn thân |
| `location` | bối cảnh, nơi | ngang, wide shot |
| `creature` | sinh vật | dọc, toàn thân |
| `visual_asset` | đạo cụ, logo, sản phẩm | dọc, cận |
| `other` | còn lại | vuông |

### `entities[].voice_description` — giọng

Nối vào prompt clip để model giữ giọng nhất quán. Tiếng Việt được. Bỏ trống
nếu nhân vật không nói.

### `scenes[].image_prompt` — một KHUNG HÌNH TĨNH

Tả khoảnh khắc đầu của cảnh: ai, ở đâu, đang làm gì, bố cục ra sao. Không tả
chuyển động, không tả âm thanh.

**Phải nhắc `@tag` của nhân vật trong cảnh.** Tài liệu Runway nói rõ tag
"is used to reference the image in prompt text" — gửi ảnh tham chiếu mà prompt
không nhắc `@tag` thì model **bỏ qua ảnh đó**, và nhân vật sẽ khác hẳn giữa các
cảnh. Server có tự nối `@tag` còn thiếu vào cuối prompt để không bao giờ hỏng
âm thầm, nhưng viết `@tag` đúng chỗ trong câu thì bố cục ra tốt hơn nhiều.

`@tag` suy từ tên, bỏ dấu, chữ thường, nối gạch dưới: `Sạp Cá` → `@sap_ca`,
`Bà Lan` → `@ba_lan`. Chạy `node scripts/rw.mjs show <projectId>` để xem tag thật.

**Tối đa 3 thực thể có ảnh tham chiếu mỗi cảnh** — giới hạn cứng của API.
Cảnh nào cần hơn thì tách thành hai cảnh. Nếu vượt, server giữ lại những
`@tag` bạn có nhắc trong prompt và bỏ phần còn lại, rồi báo lại tên bị bỏ.

### `scenes[].video_prompt` — CHUYỂN ĐỘNG

Tả cảnh động lên từ khung tĩnh. Nên có mốc thời gian và góc máy — đây là thứ
làm clip ra có nhịp thay vì trôi vô hướng.

- Đúng: `0-3s: wide shot, nắng sớm xuyên qua mái lá. 3-8s: dolly in chậm về phía @pippip, cô ngẩng lên mỉm cười`
- Sai: `Chú mèo vui vẻ` ← không có chuyển động, không có mốc, không có góc máy

Server tự nối `voice_description` và câu chặn nhạc nền (`No background music.
Keep only natural sound effects`) để về sau ghép nhạc riêng ở hậu kỳ.

## Ràng buộc kỹ thuật — sai là bị từ chối 400

### Thời lượng mỗi cảnh

| model | `duration` hợp lệ |
|---|---|
| `gen4_turbo` | số nguyên 2–10 |
| `gen4.5` | số nguyên 2–10 |
| `veo3.1`, `veo3.1_fast` | **chỉ 4, 6 hoặc 8** |
| `wan3` | 2–30 |

Video dài hơn 10s thì **phải** chia nhiều cảnh — không có model nào ra một
clip 30s. Một truyện 32s = 4 cảnh × 8s.

### Khung hình

`gen4_turbo` và `gen4.5` chỉ nhận: `1280:720`, `720:1280`, `1104:832`,
`832:1104`, `960:960`, `1584:672`. Dọc thì `720:1280`, ngang thì `1280:720`.

**Mọi cảnh trong một video phải cùng `ratio` và cùng `model`** — bước ghép dùng
`ffmpeg -c copy`, trộn model sẽ khác codec và phải encode lại.

## Bước 3 — Chạy pipeline

Bốn bước, theo thứ tự. Mỗi bước phải xong mới sang bước sau, vì bước sau ăn
kết quả bước trước.

```bash
node scripts/rw.mjs refs   <projectId>    # 1. ảnh tham chiếu
node scripts/rw.mjs watch  <videoId>      #    chờ xong
node scripts/rw.mjs images <videoId>      # 2. ảnh khung đầu
node scripts/rw.mjs watch  <videoId>
node scripts/rw.mjs clips  <videoId>      # 3. clip
node scripts/rw.mjs watch  <videoId>
node scripts/rw.mjs concat <videoId>      # 4. ghép
```

`images` sẽ **từ chối** nếu còn thực thể chưa có ảnh tham chiếu, và nói rõ
thiếu ai. Đó là cố ý: sinh ảnh cảnh khi chưa có ref sẽ ra nhân vật khác hẳn
mà vẫn bị tính tiền. Chỉ dùng `--force` khi người dùng đồng ý bỏ qua.

Hàng đợi của server chạy **một việc một lúc** (giới hạn của Runway cho cả tổ
chức), nên `refs` với 5 thực thể là 5 việc xếp hàng, không phải chạy song song.
`watch` hiện tiến độ tới khi hàng đợi rỗng.

## Chi phí — kiểm TRƯỚC khi chạy

```bash
node scripts/rw.mjs cost <videoId>
```

In ra phần còn phải tốn, đối chiếu số dư, và nói thẳng nếu không đủ.

Giá tham khảo (nguồn duy nhất là `/guides/pricing` của Runway):

- ảnh tham chiếu `gen4_image`: 5 credit (720p) / 8 (1080p)
- ảnh khung đầu `gen4_image_turbo`: 2 credit
- clip `gen4_turbo`: 5 credit/giây → 8s = 40
- clip `gen4.5`: 12 credit/giây → 8s = 96
- clip `seedance2`: 36 credit/giây → 8s = 288

Một truyện 32s, 4 cảnh, 3 thực thể, `gen4_turbo`: **≈ 183 credit**.
Cùng truyện với `gen4.5`: **≈ 407 credit**.

**Luôn báo số credit và chờ người dùng đồng ý trước khi chạy `refs`/`images`/
`clips`.** Đây là tiền thật của họ. `plan`, `upload-*`, `status`, `cost` thì
miễn phí — chạy thoải mái.

Hết credit thì job trả `REQUEST.INSUFFICIENT_CREDITS`. Ảnh bị chặn vì an toàn
nội dung (`SAFETY.INPUT.*`) **vẫn bị tính tiền** và không hoàn.

## Ảnh có sẵn

Trong kịch bản: `ref_image` cho thực thể, `frame_image` cho cảnh. Đường dẫn
tương đối tính từ vị trí file JSON.

Gắn thêm sau khi đã tạo:

```bash
node scripts/rw.mjs upload-ref   <entityId> anh/ba-lan.jpg
node scripts/rw.mjs upload-frame <sceneId>  anh/khung-mo-dau.png
```

Upload **không tốn credit**. Server giữ bản gốc trên đĩa và tự đẩy lại lên
Runway trước mỗi lần sinh, vì URI của Runway đều có hạn.

`frame_image` bỏ qua hẳn bước sinh ảnh cảnh, tiết kiệm 2–8 credit mỗi cảnh.

## Báo lại cho người dùng thế nào

Sau `plan`: nói đã tạo bao nhiêu cảnh, tổng thời lượng, còn tốn bao nhiêu
credit, số dư còn lại. Đưa `projectId` và `videoId`.

Sau mỗi bước: nói xong mấy việc, còn mấy việc, bước tiếp là gì.

Nếu job lỗi: đọc mã lỗi từ `watch`/giao diện và giải thích, đừng chỉ dán mã.

Người dùng xem tiến độ trên giao diện web ở tab **Pipeline** — có sẵn thanh
tiến độ 4 bước và ảnh thu nhỏ từng cảnh.

## Đừng làm

- Đừng tự bịa cốt truyện khi người dùng chưa kể.
- Đừng chạy bước sinh (`refs`/`images`/`clips`) trước khi báo chi phí và được đồng ý.
- Đừng tả ngoại hình thay cho ảnh thật khi người dùng đã có ảnh.
- Đừng nhồi hơn 3 thực thể có ảnh tham chiếu vào một cảnh — tách cảnh.
- Đừng trộn `model` hoặc `ratio` giữa các cảnh trong cùng một video.
- Đừng dùng `--force` cho `images` khi chưa hỏi.
