# Runway Studio

Giao diện web nội bộ cho Runway API. Chạy trên một máy, cả team truy cập bằng trình duyệt.

Form được **sinh tự động từ OpenAPI spec** của Runway — 21 endpoint, 72 biến thể model — nên khi Runway ra model mới chỉ cần tải lại spec, không phải sửa code giao diện.

---

## Chạy bằng Docker (khuyên dùng)

```bash
cp .env.example .env        # rồi điền RUNWAY_API_KEY vào
docker compose up -d --build
```

Mở http://localhost:3000. Xem mã đăng nhập admin:

```bash
docker compose logs studio | grep "Admin"
```

API key đọc từ `.env`, **không nằm trong image**. Dữ liệu (người dùng, lịch sử) và file kết quả nằm trong named volume nên sống qua mỗi lần build lại.

## Chạy trực tiếp bằng Node

Cần Node 18 trở lên.

```bash
npm install
npm run catalog                      # sinh public/catalog.json từ spec
cd web && npm install && npm run build && cd ..
npm start
```

Trên Windows có thể double-click **`start.bat`**.

---

## API key

Key **chỉ tồn tại ở server**, trình duyệt không bao giờ nhận được. Server tìm theo thứ tự:

1. biến môi trường `RUNWAY_API_KEY`
2. file `.env` cạnh `server.mjs`
3. biến môi trường cấp User trong registry Windows

Cách 3 cho phép chạy ngay sau khi `setx` mà không cần khởi động lại terminal.

## Cho người khác truy cập

1. Mở firewall (PowerShell **quyền Administrator**):
   ```powershell
   powershell -ExecutionPolicy Bypass -File open-firewall.ps1
   ```
2. Đăng nhập bằng mã admin → nút **Users** góc dưới trái → thêm người dùng.
3. Gửi mã truy cập cho từng người kèm địa chỉ LAN.

Xoá tài khoản là thu hồi quyền ngay. Mỗi job đều ghi lại ai tạo.

---

## Hạn mức — điểm quan trọng nhất

| Nhóm model | Đồng thời | Mỗi ngày |
|---|---|---|
| Video | **1** | 50 |
| Ảnh | 2 | 200 |
| Âm thanh | 1 | 50 |

Các con số này tính cho **toàn tổ chức**, không phải mỗi người. Một người đang render video thì người thứ hai phải chờ.

Vì vậy hàng đợi đặt ở **server**, không phải trình duyệt:

- Job vào queue chung, server dispatch khi có slot trống.
- Gặp `429` thì job tự quay lại đầu queue và thử lại sau 15 giây, không báo lỗi cho người dùng.
- Server tự poll task nên đóng tab vẫn chạy tiếp, kết quả vẫn vào lịch sử.
- Mọi client thấy trạng thái theo thời gian thực qua SSE.

---

## Endpoint được suy ra, không phải chọn

Người dùng không chọn giữa `text_to_video` / `image_to_video` / `video_to_video`. Họ chọn **muốn ra gì** rồi đính file; endpoint được suy ra:

| Muốn ra | Đính kèm | Endpoint | Model hợp lệ |
|---|---|---|---|
| Video | — | `text_to_video` | 15 |
| Video | ảnh | `image_to_video` | 16 |
| Video | video | `video_to_video` + `character_performance` | 9 |
| Ảnh | — hoặc ảnh tham chiếu | `text_to_image` | 11–12 |
| Âm thanh | — | `text_to_speech`, `sound_effect` | 5 |
| Âm thanh | audio | `speech_to_speech`, `voice_dubbing`, `voice_isolation` | 3 |

Danh sách model tự lọc theo tổ hợp đó, nên không bao giờ chọn được tổ hợp sai.

Logic này đọc hoàn toàn từ catalog, không hard-code đường dẫn. Kiểm chứng lại:

```bash
cd web && npm run check:routing
```

---

## Cấu trúc

```
server.mjs                  backend: auth, hàng đợi, proxy, poll task
scripts/build-catalog.mjs   OpenAPI spec -> catalog.json
spec/runway-openapi.json    spec gốc từ docs.dev.runwayml.com
web/                        frontend React + TypeScript + Vite
  src/lib/catalog.ts        suy ra endpoint từ input
  src/store.ts              zustand
  src/components/           Composer, Gallery, ui
public/catalog.json         sinh tự động, đừng sửa tay
public/dist/                frontend đã build
data/                       users.json, history.json, secret.key  (gitignored)
outputs/                    file đã lưu về máy chủ                (gitignored)
```

## Cập nhật khi Runway ra model mới

```bash
curl -o spec/runway-openapi.json https://docs.dev.runwayml.com/openapi.json
npm run catalog
```

UI tự có model mới, không phải sửa code giao diện.

## Lưu kết quả

Link output của Runway nhúng JWT có hạn — quan sát thực tế khoảng **48 giờ**. Nút **Lưu** tải file về `outputs/`, xem lại qua `/outputs/<tên file>`.

---

## Giới hạn đã biết

- **Chưa có UI** cho Avatars, Voices, Workflows, Model Router, Knowledge, Realtime Sessions. Backend proxy đã sẵn.
- **Hàng đợi nằm trong bộ nhớ.** Restart server thì job đang chạy mất khỏi queue (lịch sử vẫn còn, task vẫn chạy bên Runway).
- **Lịch sử lưu bằng file JSON.** Đủ dùng ở quy mô nội bộ vì server chỉ có một tiến trình và thao tác ghi là đồng bộ. Sẽ chậm dần khi vượt vài nghìn bản ghi — lúc đó nên chuyển sang SQLite.
- **Backend vẫn là JavaScript**, chưa chuyển TypeScript như thiết kế ban đầu. Logic hàng đợi và xác thực đã chạy đúng và được kiểm chứng, nên hoãn việc viết lại để tránh rủi ro không đổi lấy lợi ích nào cho người dùng.
- **Xác thực bằng mã chia sẻ**, phù hợp mạng nội bộ tin cậy. **Đừng mở thẳng ra internet** — nếu cần, đặt sau reverse proxy có HTTPS và thêm tầng xác thực thật.

## Những gì Runway API không có

Đối chiếu trên toàn bộ 49 path của spec — các chức năng sau **không có endpoint** nên không thể làm giống web app Runway: quản lý project/folder, asset library, timeline editor, canvas nhiều lớp, session cộng tác, tài khoản người dùng riêng.
