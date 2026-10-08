#!/bin/sh
set -e

# Escape replacement text for sed ("&" has special meaning)
escape_sed_replacement() {
    printf '%s' "$1" | sed 's/&/\\&/g'
}

replace_placeholder_in_js() {
    placeholder="$1"
    replacement="$2"

    js_files=$(find "$WWW_ROOT" -type f -name "*.js" 2>/dev/null)
    [ -z "$js_files" ] && return 0

    escaped_replacement=$(escape_sed_replacement "$replacement")
    printf '%s\n' "$js_files" | while IFS= read -r file; do
        sed -i "s^${placeholder}^${escaped_replacement}^g" "$file"
    done
}

# Set document root based on LEGACY_MODE (run with -e LEGACY_MODE=true for legacy UI)
if [ "$LEGACY_MODE" = "true" ] || [ "$LEGACY_MODE" = "1" ] || [ "$LEGACY_MODE" = "yes" ]; then
    export NGINX_ROOT=/var/www/legacy
    WWW_ROOT=/var/www/legacy
    echo "Serving legacy UI from $WWW_ROOT"
else
    export NGINX_ROOT=/var/www
    WWW_ROOT=/var/www
    echo "Serving default UI from $WWW_ROOT"
fi

# Copy build output to /var/www if present (Dockerfile.cross flow)
if [ -d /opt/ui/dist ]; then
    cp -rv /opt/ui/dist/* "$WWW_ROOT"
fi

# Replace placeholders in all .js files (including assets/*.js)
if [ -n "$BASE_URL_OVERRIDE" ]; then
    echo "running with BASE_URL=${BASE_URL_OVERRIDE}"
    replace_placeholder_in_js "{PLACEHOLDER_BASE_URL}" "$BASE_URL_OVERRIDE"
else
    echo "running with BASE_URL=${BASE_URL}"
    replace_placeholder_in_js "{PLACEHOLDER_BASE_URL}" "$BASE_URL"
fi

if [ -n "$OPENCOST_FOOTER_CONTENT" ]; then
    replace_placeholder_in_js "PLACEHOLDER_FOOTER_CONTENT" "$OPENCOST_FOOTER_CONTENT"
else
    replace_placeholder_in_js "PLACEHOLDER_FOOTER_CONTENT" "OpenCost version: $VERSION ($HEAD)"
fi

# Display names for the Cloud Accounts page: a JSON object mapping a billing
# account ID (or a project ID) to the name to show, e.g.
#   CLOUD_ACCOUNT_NAMES='{"012345-6789AB-CDEF01":"PetCare"}'
# Written as a file the page fetches, so a name can change without a rebuild.
# Anything that is not a JSON object is replaced by {} rather than served as is.
if [ -n "$CLOUD_ACCOUNT_NAMES" ] && printf '%s' "$CLOUD_ACCOUNT_NAMES" | grep -q '^[[:space:]]*{.*}[[:space:]]*$'; then
    echo "writing cloud-accounts.json"
    printf '%s' "$CLOUD_ACCOUNT_NAMES" > "$WWW_ROOT/cloud-accounts.json"
else
    printf '{}' > "$WWW_ROOT/cloud-accounts.json"
fi

# Custom aggregation options: JSON object (map string:string), e.g. {"Label: team":"label:team"}
if [ -n "$CUSTOM_AGGREGATION_OPTIONS" ]; then
    echo "injecting CUSTOM_AGGREGATION_OPTIONS"
    esc=$(printf '%s' "$CUSTOM_AGGREGATION_OPTIONS" | sed 's/\\/\\\\/g; s/"/\\"/g')
    replace_placeholder_in_js "PLACEHOLDER_CUSTOM_AGGREGATIONS" "$esc"
fi

if [ ! -e /etc/nginx/conf.d/default.nginx.conf ]; then
    envsubst '$API_PORT $API_SERVER $UI_PORT $NGINX_ROOT $UI_PATH $BASE_URL $PROXY_CONNECT_TIMEOUT $PROXY_SEND_TIMEOUT $PROXY_READ_TIMEOUT' \
        < /etc/nginx/conf.d/default.nginx.conf.template \
        > /etc/nginx/conf.d/default.nginx.conf
fi
echo "Starting OpenCost UI version $VERSION ($HEAD)"

# Run the parent (nginx) container's entrypoint script
exec /docker-entrypoint.sh "$@"
