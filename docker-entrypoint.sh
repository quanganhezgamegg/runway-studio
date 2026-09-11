#!/bin/sh
# Volume do nen tang gan vao (Railway, Fly, Render) thuoc root, khong phai user
# `node`. Neu chay san bang `node` thi mkdir trong volume do bi EACCES.
#
# Entrypoint nay khoi dong bang root chi de chown thu muc luu tru, roi HA QUYEN
# xuong `node` truoc khi chay app. App khong bao gio chay bang root.
set -e

for d in "${DATA_DIR:-/app/data}" "${OUTPUTS_DIR:-/app/outputs}"; do
  mkdir -p "$d" 2>/dev/null || true
  # Chi chown chinh thu muc, khong -R: file ben trong do `node` tao ra da
  # thuoc `node` san, va -R tren thu muc outputs nhieu file se rat cham.
  chown node:node "$d" 2>/dev/null || true
done

# Neu chown that bai (mot so nen tang khong cho), chay bang root con hon la
# crash-loop - nhung phai noi ro ra log.
if su-exec node test -w "${DATA_DIR:-/app/data}"; then
  exec su-exec node "$@"
fi

echo "  CANH BAO : khong chiem duoc quyen ghi tren ${DATA_DIR:-/app/data} cho user node."
echo "             Chay bang root de app khong crash. Nen kiem tra lai volume."
exec "$@"
