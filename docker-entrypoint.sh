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
# A value may also be an object giving the billing currency (default USD):
#   {"123456789012":{"name":"Main AWS","currency":"USD"}}
# Written as a file the page fetches, so a name can change without a rebuild.
# Anything that is not a JSON object is replaced by {} rather than served as is.
if [ -n "$CLOUD_ACCOUNT_NAMES" ] && printf '%s' "$CLOUD_ACCOUNT_NAMES" | grep -q '^[[:space:]]*{.*}[[:space:]]*$'; then
    echo "writing cloud-accounts.json"
    printf '%s' "$CLOUD_ACCOUNT_NAMES" > "$WWW_ROOT/cloud-accounts.json"
else
    printf '{}' > "$WWW_ROOT/cloud-accounts.json"
fi

# Display currency for the Cloud Accounts page, e.g. CLOUD_DISPLAY_CURRENCY=INR.
# When set, every account is also shown converted into it. Three capital
# letters or nothing: anything else is ignored rather than served.
DISPLAY_JSON=""
if printf '%s' "$CLOUD_DISPLAY_CURRENCY" | grep -q '^[A-Z][A-Z][A-Z]$'; then
    echo "display currency: $CLOUD_DISPLAY_CURRENCY"
    DISPLAY_JSON="\"currency\":\"$CLOUD_DISPLAY_CURRENCY\""
fi

# Fixed costs that can be added and changed from the Cloud Accounts page.
# OFF unless FIXED_COSTS_DIR names a directory this container can write to,
# normally a mounted volume (anything else is lost when the container goes).
# The page then keeps ONE file there, store/fixed-costs.json: nginx serves it
# and takes it back with PUT (see the template). Nothing else can be written.
#
# ⚠️ There is no login in this image. Whoever can reach the interface can
# change that file, so run it behind a login, as you must anyway.
# ⚠️ nginx stores what it is sent without reading it. The page only ever sends
# a list it has checked, and ignores stored entries it does not understand.
FIXED_COSTS_LOCATION=""
if [ -n "$FIXED_COSTS_DIR" ]; then
    # The path goes into the nginx config, so only a plain absolute path is taken.
    if printf '%s' "$FIXED_COSTS_DIR" | grep -q '^/[A-Za-z0-9_./-]*$' \
        && mkdir -p "$FIXED_COSTS_DIR/store" "$FIXED_COSTS_DIR/tmp" 2>/dev/null \
        && [ -w "$FIXED_COSTS_DIR/store" ] && [ -w "$FIXED_COSTS_DIR/tmp" ]; then
        # An existing file is NEVER touched here: it is the saved data.
        [ -e "$FIXED_COSTS_DIR/store/fixed-costs.json" ] || printf '{"fixed":[]}' > "$FIXED_COSTS_DIR/store/fixed-costs.json"
        echo "fixed costs can be edited from the page, kept in $FIXED_COSTS_DIR"
        DISPLAY_JSON="${DISPLAY_JSON:+$DISPLAY_JSON,}\"fixedCostsEditable\":true"
        FIXED_COSTS_LOCATION="location = /store/fixed-costs.json {
        limit_except GET PUT { deny all; }
        root $FIXED_COSTS_DIR;
        dav_methods PUT;
        create_full_put_path off;
        dav_access user:rw group:rw;
        # Same volume as the file, so a save is one rename and never half a file.
        client_body_temp_path $FIXED_COSTS_DIR/tmp;
        client_max_body_size 32k;
        default_type application/json;
        add_header Cache-Control \"no-store\";
    }"
    else
        echo "FIXED_COSTS_DIR ($FIXED_COSTS_DIR) is not a writable directory: editing fixed costs is OFF"
    fi
fi
export FIXED_COSTS_LOCATION
printf '{%s}' "$DISPLAY_JSON" > "$WWW_ROOT/cloud-display.json"

# The DNS servers this container was given, for the exchange-rate relay in the
# nginx config: it resolves its upstream at request time and nginx has to be
# told which resolver to use. Read from resolv.conf so the same image works in
# Docker and in a cluster. IPv6 addresses need brackets in nginx.
FX_RESOLVERS=$(awk '/^nameserver/ { if ($2 ~ /:/) printf "[%s] ", $2; else printf "%s ", $2 }' /etc/resolv.conf 2>/dev/null)
[ -n "$FX_RESOLVERS" ] || FX_RESOLVERS="127.0.0.1"
export FX_RESOLVERS

# Custom aggregation options: JSON object (map string:string), e.g. {"Label: team":"label:team"}
if [ -n "$CUSTOM_AGGREGATION_OPTIONS" ]; then
    echo "injecting CUSTOM_AGGREGATION_OPTIONS"
    esc=$(printf '%s' "$CUSTOM_AGGREGATION_OPTIONS" | sed 's/\\/\\\\/g; s/"/\\"/g')
    replace_placeholder_in_js "PLACEHOLDER_CUSTOM_AGGREGATIONS" "$esc"
fi

if [ ! -e /etc/nginx/conf.d/default.nginx.conf ]; then
    envsubst '$API_PORT $API_SERVER $UI_PORT $NGINX_ROOT $UI_PATH $BASE_URL $PROXY_CONNECT_TIMEOUT $PROXY_SEND_TIMEOUT $PROXY_READ_TIMEOUT $FX_RESOLVERS $FIXED_COSTS_LOCATION' \
        < /etc/nginx/conf.d/default.nginx.conf.template \
        > /etc/nginx/conf.d/default.nginx.conf
fi
echo "Starting OpenCost UI version $VERSION ($HEAD)"

# Run the parent (nginx) container's entrypoint script
exec /docker-entrypoint.sh "$@"
