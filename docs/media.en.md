# Attachments and replies

[中文](media.md) · [English](media.en.md)

| Content | Read | Reply |
| --- | --- | --- |
| Text | Plain and mixed text | At most 20,000 characters; above 600 native characters send the full `answer.txt` |
| Images | PNG, JPEG, GIF | PNG, JPEG, GIF |
| Voice | AMR, WAV, MP3, Ogg; preserve platform transcript | Existing AMR, at most 60 seconds and 2 MiB |
| Files | Original bytes and supported excerpts | Original file |
| Video | Type information | Not implemented |

Each attachment is at most 5 MiB. Accepted messages retain private download information; content is read on demand. If download codes/session references expire, resend the original attachment in the owner DM.

Use `get_dingtalk_message`, then `get_dingtalk_attachment` by index. Shared protected Linux processing can provide PDF/Office excerpts and optional local transcription. Truncation is explicit; raw audio and textual transcripts remain distinct inputs.

Choose one final reply: `reply_to_dingtalk`, `reply_dingtalk_media`, or `reply_dingtalk_attachment`. Media has no extra caption and uses the bound owner recipient. Voice replies require an existing supported AMR recording.

Downloads use recognized DingTalk HTTPS services. Recognized official OSS HTTP references are upgraded to the same host's HTTPS address before any request. Review unknown official nodes through operations while retaining destination/TLS checks.

The positive platform response confirms acceptance. Inspect `get_dingtalk_reply_status` for final delivery; ambiguous results remain uncertain and are not replayed automatically.
