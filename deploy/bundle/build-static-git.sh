#!/bin/sh
# Static, relocatable git for the agent bundle (ADR-0183).
#
#   build-static-git.sh <curl.tar.xz> <git.tar.xz> <out>
#
# Runs in an Alpine stage whose two archives were already verified by
# `scripts/build/bundle-agent-versions.mjs fetch-tool` (curl by PGP signature,
# git by sha256). Produces <out>/common/git and <out>/common/bin/git.
#
# Why each choice:
# - libcurl is built here, minimal (OpenSSL + zlib only), instead of linking
#   Alpine's: the set of `-static` packages Alpine's libcurl needs changes
#   between releases, and git only needs plain HTTPS from it.
# - RUNTIME_PREFIX: git finds libexec/templates relative to its own binary, so
#   the tree works at /cognia/common/git inside any image.
# - INSTALL_SYMLINKS + SKIP_DASHED_BUILT_INS: relative symlinks instead of a
#   hundred hard links, which `cognia-sandboxd install` would copy as a hundred
#   separate multi-megabyte files.
# - sysconfdir=/etc: the image's own /etc/gitconfig still applies.
# - NO_REGEX, NO_SYS_POLL_H, ICONV_OMITS_BOM: the settings Alpine's own git
#   package uses on musl.
set -eu

curl_archive=$1
git_archive=$2
out=$3
jobs=$(nproc)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/curl-src" "$work/git-src" "$work/curl"
tar -xJf "$curl_archive" -C "$work/curl-src" --strip-components=1
tar -xJf "$git_archive" -C "$work/git-src" --strip-components=1

(
  cd "$work/curl-src"
  ./configure \
    --prefix="$work/curl" \
    --disable-shared --enable-static \
    --with-openssl --with-zlib \
    --with-ca-bundle=/etc/ssl/certs/ca-certificates.crt \
    --without-libpsl --without-brotli --without-zstd --without-nghttp2 \
    --without-nghttp3 --without-ngtcp2 --without-libidn2 --without-libssh2 \
    --without-librtmp \
    --disable-ldap --disable-ldaps --disable-rtsp --disable-dict \
    --disable-telnet --disable-tftp --disable-pop3 --disable-imap \
    --disable-smtp --disable-gopher --disable-mqtt --disable-manual \
    --disable-docs
  make -j"$jobs"
  make install
)

curl_libs=$(PKG_CONFIG_PATH="$work/curl/lib/pkgconfig" pkg-config --static --libs libcurl)

(
  cd "$work/git-src"
  make -j"$jobs" \
    prefix=/cognia/common/git \
    sysconfdir=/etc \
    RUNTIME_PREFIX=YesPlease \
    INSTALL_SYMLINKS=YesPlease \
    NO_INSTALL_HARDLINKS=YesPlease \
    SKIP_DASHED_BUILT_INS=YesPlease \
    NO_TCLTK=YesPlease \
    NO_GETTEXT=YesPlease \
    NO_PERL=YesPlease \
    NO_PYTHON=YesPlease \
    NO_EXPAT=YesPlease \
    NO_OPENSSL=YesPlease \
    NO_REGEX=YesPlease \
    NO_SYS_POLL_H=1 \
    ICONV_OMITS_BOM=Yes \
    CURLDIR="$work/curl" \
    CURL_CONFIG="$work/curl/bin/curl-config" \
    CURL_LDFLAGS="$curl_libs" \
    CFLAGS="-O2" \
    LDFLAGS="-static" \
    DESTDIR="$work/root" \
    all install
)

mkdir -p "$out/common/bin"
cp -a "$work/root/cognia/common/git" "$out/common/git"
ln -s ../git/bin/git "$out/common/bin/git"

# Every ELF in the tree must be static: the tree runs in images of either libc.
for file in $(find "$out/common/git" -type f); do
  if head -c 4 "$file" | grep -q "ELF" && readelf -l "$file" | grep -q "INTERP"; then
    echo "build-static-git: $file is dynamically linked" >&2
    exit 1
  fi
done
# And nothing may point outside it once relocated.
if find "$out/common/git" -type l -lname '/*' | grep -q .; then
  echo "build-static-git: absolute symlinks in the git tree:" >&2
  find "$out/common/git" -type l -lname '/*' >&2
  exit 1
fi
test -x "$out/common/git/libexec/git-core/git-remote-https"
"$out/common/git/bin/git" --version
