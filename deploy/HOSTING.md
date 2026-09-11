# Chọn nền tảng để host

App này **có trạng thái**: hàng đợi trong bộ nhớ, tự poll task tới 30 phút, SSE
giữ kết nối lâu, và ghi file vào `data/` + `outputs/`. Nên nó cần một
**tiến trình chạy liên tục + volume lưu được**, không phải serverless.

## Không dùng được

| Nền tảng | Vì sao |
|---|---|
| **Vercel** | Filesystem chỉ đọc, `/tmp` tạm theo instance. Mỗi request là instance mới nên hàng đợi và `CLIENTS` (SSE) không chia sẻ được. `secret.key` sinh khác nhau mỗi instance làm mất phiên đăng nhập. |
| **Netlify Functions** | Cùng lý do. |
| **Cloudflare Workers** | Không có filesystem, không chạy được Express như hiện tại. |

Muốn dùng được phải thay queue sang Redis/Postgres, polling sang cron ngoài,
SSE sang dịch vụ realtime, `outputs/` sang object storage. Viết lại gần hết
backend để có thứ kém tin cậy hơn bản hiện tại.

## Dùng được, không sửa code

Cả ba đều nhận `Dockerfile` sẵn có.

### Railway — gần Vercel nhất về trải nghiệm

1. [railway.app](https://railway.app) → **New Project → Deploy from GitHub repo** → chọn `runway-studio`
2. Railway tự nhận `Dockerfile`
3. Tab **Variables**, thêm:
   ```
   RUNWAY_API_KEY=key_...
   SESSION_SECRET=<64 ký tự hex ngẫu nhiên>
   TRUST_PROXY=1
   FORCE_SECURE_COOKIE=1
   ```
   Sinh secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
4. Tab **Settings → Volumes**, tạo hai volume:
   - mount `/app/data` — người dùng, lịch sử
   - mount `/app/outputs` — file đã lưu
5. **Settings → Networking → Generate Domain** (hoặc gắn domain riêng)
6. Xem mã admin ở tab **Deployments → View Logs**, tìm dòng `Admin`

Push lên `main` là tự deploy lại.

### Render

Tương tự, chọn **New → Web Service → Docker**. Persistent Disk cần gói trả phí
(Starter ~$7/tháng). Mount `/app/data` và `/app/outputs`.

### Fly.io

```bash
fly launch --no-deploy          # tự nhận Dockerfile
fly volumes create studio_data --size 3
fly secrets set RUNWAY_API_KEY=key_... SESSION_SECRET=$(openssl rand -hex 32)
# thêm vào fly.toml:
#   [[mounts]]
#     source = "studio_data"
#     destination = "/app/data"
fly deploy
```

Rẻ nhất trong ba, nhưng thao tác qua CLI nhiều hơn.

## Bắt buộc sau khi deploy, dù chọn nền tảng nào

1. Đăng nhập → **Users** → **Tạo lại mã** cho mọi tài khoản.
   Mã cũ chỉ 8 ký tự, không đủ cho internet. Giao diện tô đỏ mã như vậy.
2. Kiểm tra `/outputs/<file>` ở cửa sổ ẩn danh phải trả `401`.
3. Xem log định kỳ: tìm `ma sai` để biết có ai đang dò mã.

## Ba biến môi trường dễ đặt sai

- `TRUST_PROXY=1` — chỉ bật khi thật sự sau reverse proxy. Bật khi chạy trực
  tiếp thì client tự đặt `X-Forwarded-For` là vượt được giới hạn thử login.
- `FORCE_SECURE_COOKIE=1` — chỉ bật khi có HTTPS. Bật mà không có HTTPS thì
  trình duyệt bỏ qua cookie và **không đăng nhập được**.
- `SESSION_SECRET` — đặt cố định. Bỏ trống mà volume chưa gắn đúng thì mỗi lần
  deploy lại sinh secret mới, mọi người bị đăng xuất.
