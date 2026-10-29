#!/usr/bin/env bash
# 把 site/latest.json 和 site/download/ 里的安装包传到 ECS 的 /var/www/cover-maker/（2026-10-19）
#   · 对外：https://foswift.com/cover-maker/latest.json —— 下载页 /download 和软件「检查更新」都读它
#   · 第一次跑会给 nginx 加 location ^~ /cover-maker/（先备份、nginx -t 不过就自动还原）；以后跑只同步文件
#   · 发新版：改 package.json version → 打包 → 安装包放 site/download/ → 改 site/latest.json → 跑本脚本
#   · 先传安装包、最后传 latest.json：用户看到新版本号时安装包一定已经在了
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SITE="$ROOT/site"
# 服务器信息放在 tools/publish.env（不进 git），格式见 README
[ -f "$ROOT/tools/publish.env" ] && . "$ROOT/tools/publish.env"
KEY="${PUBLISH_KEY:?缺 PUBLISH_KEY，写进 tools/publish.env}"
KNOWN="${PUBLISH_KNOWN:?缺 PUBLISH_KNOWN，写进 tools/publish.env}"
HOST="${PUBLISH_HOST:?缺 PUBLISH_HOST，写进 tools/publish.env}"
SSH=(ssh -i "$KEY" -o UserKnownHostsFile="$KNOWN" -o BatchMode=yes "$HOST")
SCP=(scp -i "$KEY" -o UserKnownHostsFile="$KNOWN" -o BatchMode=yes)

python -c "import json,sys; d=json.load(open(sys.argv[1],encoding='utf-8')); assert d['version']; print('latest.json 版本', d['version'])" "$SITE/latest.json"

echo "== 1/3 nginx（已有就跳过）"
"${SCP[@]}" "$ROOT/tools/nginx-cover-maker.conf" "$HOST:/tmp/cover-maker-location.conf"
"${SSH[@]}" 'set -e
F=/etc/nginx/sites-enabled/front-vue-page
sudo mkdir -p /var/www/cover-maker/download
if sudo grep -q "location ^~ /cover-maker/" $F; then echo "已配置，跳过"; exit 0; fi
B=/home/ecs-user/nginx-front-vue-page.bak.cover-maker-$(date +%Y%m%d-%H%M%S)
sudo cp -p $F $B && echo "备份 → $B"
N=$(sudo awk "/location \\^~ \\/community-media\\//{f=1} f && /^    }/{print NR; exit}" $F)
[ -n "$N" ] || { echo "找不到 community-media 块，没改"; exit 1; }
sudo awk -v n=$N -v ins=/tmp/cover-maker-location.conf "{print} NR==n{while((getline l < ins)>0) print l}" $F | sudo tee /tmp/fvp.new >/dev/null
sudo diff $F /tmp/fvp.new || true
sudo cp /tmp/fvp.new $F && sudo chown root:root $F && sudo chmod 644 $F
if sudo nginx -t; then sudo systemctl reload nginx && echo "nginx 已 reload"
else echo "nginx -t 没通过 → 还原"; sudo cp -p $B $F; sudo nginx -t; exit 1; fi'

echo "== 2/3 安装包"
"${SSH[@]}" 'mkdir -p /tmp/cover-maker-upload/download'
shopt -s nullglob
for f in "$SITE"/download/*; do
  name="$(basename "$f")"
  if "${SSH[@]}" "[ \"\$(stat -c %s /var/www/cover-maker/download/$name 2>/dev/null)\" = \"$(stat -c %s "$f")\" ]"; then
    echo "  $name 已在服务器上，跳过"
  else
    echo "  上传 $name"
    "${SCP[@]}" "$f" "$HOST:/tmp/cover-maker-upload/download/$name"
  fi
done

echo "== 3/3 latest.json（最后切）"
"${SCP[@]}" "$SITE/latest.json" "$HOST:/tmp/cover-maker-upload/latest.json"
"${SSH[@]}" 'set -e
cd /tmp/cover-maker-upload
# 逐个先拷成 .part 再 mv：同名覆盖时正在下载的人不会拿到半截文件（10-19 第二次发版改）
for f in download/*; do [ -f "$f" ] || continue; n=$(basename "$f"); sudo cp "$f" "/var/www/cover-maker/download/.$n.part" && sudo mv -f "/var/www/cover-maker/download/.$n.part" "/var/www/cover-maker/download/$n"; done
sudo cp latest.json /var/www/cover-maker/latest.json.new && sudo mv -f /var/www/cover-maker/latest.json.new /var/www/cover-maker/latest.json
sudo chown -R www-data:www-data /var/www/cover-maker
rm -rf /tmp/cover-maker-upload /tmp/cover-maker-location.conf; sudo rm -f /tmp/fvp.new   # fvp.new 是 sudo tee 写的，普通 rm 删不掉（10-19 首跑踩到）
ls -l /var/www/cover-maker /var/www/cover-maker/download'

echo "== 线上自检"
curl -s "https://foswift.com/cover-maker/latest.json?t=$(date +%s)" | head -5
for f in "$SITE"/download/*; do
  curl -s -o /dev/null -I -w "  %{http_code} $(basename "$f")\n" "https://foswift.com/cover-maker/download/$(basename "$f")"
done
