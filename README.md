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

## Host lên server để truy cập từ xa

Xác thực của app là **mã chia sẻ** — ai lộ mã là vào được và tiêu credit. Nên **đừng phơi thẳng ra internet**. Hai đường an toàn:

### Cách 1 — Cloudflare Tunnel + Access (khuyên dùng)

Không mở port nào. `cloudflared` tự gọi ra Cloudflare nên không có kết nối vào. Cloudflare Access đặt SSO (Google / email OTP) ở phía trước, request chưa qua thì chưa tới được app — mã truy cập của app thành lớp thứ hai chứ không phải lớp duy nhất.

1. Vào [Cloudflare Zero Trust](https://one.dash.cloudflare.com) → **Networks → Tunnels → Create a tunnel** → chọn **Cloudflared**.
2. Copy token, thêm vào `.env`:
   ```
   TUNNEL_TOKEN=eyJhIjoi...
   ```
3. Ở tab **Public Hostname** của tunnel, trỏ subdomain của bạn tới `http://studio:3000`.
4. Chạy:
   ```bash
   docker compose -f docker-compose.yml -f deploy/docker-compose.tunnel.yml up -d
   ```
5. **Quan trọng** — bật Access: **Zero Trust → Access → Applications → Add an application → Self-hosted**, chọn domain vừa tạo, thêm policy `Emails ending in @congty.com` hoặc danh sách email cụ thể.

Miễn phí tới 50 người.

### Cách 2 — VPS + Caddy, URL công khai trên internet

Caddy tự xin và gia hạn chứng chỉ Let's Encrypt.

**Cần có trước:** một VPS (Ubuntu, 1GB RAM là đủ) và một tên miền trỏ A record về IP của VPS.

```bash
# --- Trên VPS ---

# 1. Docker
curl -fsSL https://get.docker.com | sh

# 2. Lấy code (repo private nên cần token hoặc deploy key)
git clone https://github.com/<user>/runway-studio.git
cd runway-studio

# 3. API key
cp .env.example .env
nano .env            # điền RUNWAY_API_KEY

# 4. Tên miền
nano deploy/Caddyfile    # thay studio.tenmien.com

# 5. Mở port
ufw allow 80/tcp && ufw allow 443/tcp

# 6. Chạy
docker compose -f docker-compose.yml -f deploy/docker-compose.public.yml up -d

# 7. Lấy mã admin
docker compose logs studio | grep Admin
```

**Bắt buộc sau khi chạy:** đăng nhập → **Users** → bấm **Tạo lại mã** cho mọi tài khoản. Mã sinh ra trước đây chỉ dài 8 ký tự, không đủ cho internet. Giao diện sẽ tô đỏ và cảnh báo những mã như vậy.

Đường này app **chỉ còn mã truy cập che chắn** — không có SSO như Cách 1. Những gì đang bảo vệ nó:

| Lớp | Chi tiết |
|---|---|
| Mã truy cập | 32 ký tự hex — 16 byte ngẫu nhiên, không dò được |
| Giới hạn thử | Sai 5 lần khoá theo IP, chờ tăng dần 30s → tối đa 15 phút |
| HTTPS | Let's Encrypt qua Caddy, kèm HSTS |
| Cookie phiên | `HttpOnly`, `SameSite=Lax`, `Secure` |
| File kết quả | `/outputs/*` yêu cầu phiên hợp lệ |
| Thu hồi | Tạo lại mã hoặc xoá tài khoản có tác dụng ngay |

Rủi ro còn lại: mã là **secret dùng chung** — ai lộ mã thì vào được và tiêu credit. Giới hạn theo IP không chặn được tấn công từ nhiều IP cùng lúc, nhưng 32 ký tự hex thì dò là bất khả thi. Hạn mức ngày của Runway (50 video / 200 ảnh cho cả tổ chức) là trần thiệt hại trong trường hợp xấu nhất.

Nên làm định kỳ: xem log `docker compose logs studio | grep "ma sai"` để phát hiện có ai đang dò.

### Hai biến môi trường bắt buộc khi chạy sau proxy

Cả hai file compose trên đã đặt sẵn:

- `TRUST_PROXY=1` — để giới hạn số lần thử login đọc được IP thật. **Không bật khi chạy trực tiếp**, vì lúc đó client tự đặt `X-Forwarded-For` là vượt được giới hạn.
- `FORCE_SECURE_COOKIE=1` — gắn cờ `Secure` cho cookie phiên. Chỉ bật khi thật sự có HTTPS, nếu không trình duyệt bỏ qua cookie và không đăng nhập được.

### Đã bịt trước khi cho host

- `/outputs/*` trước đây phục vụ **không cần đăng nhập** — tên file chứa jobId đoán được nên ai cũng tải được nội dung team đã tạo. Giờ yêu cầu phiên hợp lệ.
- `/api/login` trước đây **không giới hạn số lần thử**. Giờ sai 5 lần là khoá theo IP, thời gian chờ tăng dần 30s → 60s → … tối đa 15 phút. Mã đúng cũng không vượt được khoá, nếu không thì khoá vô nghĩa.
- Thêm `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, bỏ `X-Powered-By`.

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
store.mjs                   SQLite: project / entity / video / scene
pipeline.mjs                route pipeline + dựng payload 3 bước
batch.mjs                   lệnh hàng loạt + ghép ffmpeg
pricing.mjs                 ước tính credit (dùng chung CLI và giao diện)
scripts/rw.mjs              CLI điều khiển pipeline từ terminal
scripts/build-catalog.mjs   OpenAPI spec -> catalog.json
spec/runway-openapi.json    spec gốc từ docs.dev.runwayml.com
.claude/skills/rw-story/    skill cho Claude Code: ý tưởng -> nhiều cảnh
web/                        frontend React + TypeScript + Vite
  src/lib/catalog.ts        suy ra endpoint từ input
  src/store.ts              zustand
  src/components/           Composer, Pipeline, Gallery, ui
public/catalog.json         sinh tự động, đừng sửa tay
public/dist/                frontend đã build
data/                       users.json, history.json, studio.db   (gitignored)
outputs/                    file đã lưu + ảnh upload              (gitignored)
.rw.json / .rw-session      cấu hình + phiên của CLI              (gitignored)
```

## Làm video nhiều cảnh

Một clip Runway dài tối đa 10 giây, nên truyện dài hơn phải chia cảnh rồi ghép.
Pipeline bốn bước, mỗi bước ăn kết quả bước trước:

```
ảnh tham chiếu  →  ảnh khung đầu  →  clip  →  ghép (ffmpeg)
  mỗi thực thể      mỗi cảnh          mỗi cảnh    một video
```

Ảnh tham chiếu là thứ giữ nhân vật **giống nhau giữa các cảnh**. Bước sinh ảnh
khung đầu sẽ **từ chối** nếu còn thực thể chưa có ảnh tham chiếu, vì làm ngược
thứ tự thì ra nhân vật khác mà vẫn bị tính tiền.

Dùng trên giao diện ở tab **Pipeline**, hoặc từ terminal:

```bash
node scripts/rw.mjs help              # danh sách lệnh
node scripts/rw.mjs plan story.json   # tạo cả project từ 1 file kịch bản
node scripts/rw.mjs cost <videoId>    # còn tốn bao nhiêu credit
node scripts/rw.mjs status <videoId>  # đang ở bước nào
```

Cấu hình CLI bằng `RW_BASE` / `RW_CODE`, hoặc file `.rw.json`
(`{"base":"...","code":"..."}` — đã gitignore vì chứa mã truy cập).

Trong Claude Code, gõ `/rw-story` rồi kể ý tưởng: skill sẽ viết prompt cho từng
cảnh, tạo project, và báo chi phí trước khi chạy. Luật viết prompt nằm ở
`.claude/skills/rw-story/SKILL.md`.

### Dùng ảnh có sẵn

Model không vẽ lại được người thật, logo thật hay sản phẩm thật — phải đưa ảnh
vào. Nút **Tải ảnh** trên thẻ thực thể, nút **tải** trên hàng cảnh, hoặc:

```bash
node scripts/rw.mjs upload-ref   <entityId> anh/nguoi-that.jpg
node scripts/rw.mjs upload-frame <sceneId>  anh/khung-mo-dau.png
```

Upload **không tốn credit**. Bản gốc được lưu vào `outputs/uploads/` và tự đẩy
lại lên Runway trước mỗi lần sinh, vì mọi URI của Runway đều có hạn.

Runway chỉ nhận **3 ảnh tham chiếu** mỗi ảnh sinh ra. Cảnh nào cần hơn thì tách
cảnh; nếu vượt, server giữ những `@tag` có nhắc trong prompt và báo tên bị bỏ.

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
