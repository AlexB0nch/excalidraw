#!/bin/sh
# Turns HTTP basic auth on when BASIC_AUTH_USER and BASIC_AUTH_PASSWORD are both
# set, and leaves the site public when they are not. Runs from the stock nginx
# entrypoint before nginx starts, so the credentials are read at container start
# and changing them needs a restart, not a rebuild.
set -eu

AUTH_DIR=/etc/nginx/auth.d
PASSWD_FILE=/etc/nginx/.htpasswd

mkdir -p "$AUTH_DIR"
rm -f "$AUTH_DIR"/*.conf "$PASSWD_FILE"

if [ -z "${BASIC_AUTH_USER:-}" ] || [ -z "${BASIC_AUTH_PASSWORD:-}" ]; then
    echo "40-basic-auth.sh: BASIC_AUTH_USER/BASIC_AUTH_PASSWORD not set, serving publicly"
    exit 0
fi

case "$BASIC_AUTH_USER" in
    *:*)
        echo "40-basic-auth.sh: BASIC_AUTH_USER must not contain ':'" >&2
        exit 1
        ;;
esac

printf '%s:%s\n' \
    "$BASIC_AUTH_USER" \
    "$(openssl passwd -apr1 "$BASIC_AUTH_PASSWORD")" > "$PASSWD_FILE"
chmod 600 "$PASSWD_FILE"

cat > "$AUTH_DIR/basic-auth.conf" <<CONF
auth_basic           "Restricted";
auth_basic_user_file $PASSWD_FILE;
CONF

echo "40-basic-auth.sh: basic auth enabled for user '$BASIC_AUTH_USER'"
