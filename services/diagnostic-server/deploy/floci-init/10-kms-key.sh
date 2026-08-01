#!/bin/sh
set -eu

alias_name="alias/cognia-diagnostics"
if awslocal kms describe-key --key-id "$alias_name" >/dev/null 2>&1; then
  exit 0
fi

key_id="$(awslocal kms create-key \
  --description "Cognia diagnostic development KEK" \
  --key-usage ENCRYPT_DECRYPT \
  --key-spec SYMMETRIC_DEFAULT \
  --query 'KeyMetadata.KeyId' \
  --output text)"
awslocal kms create-alias --alias-name "$alias_name" --target-key-id "$key_id"
