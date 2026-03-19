#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any


REASONING_DETAILS_RE = re.compile(
    r"<details\s+type=\"reasoning\"[^>]*>[\s\S]*?</details>\s*",
    re.IGNORECASE,
)
CODE_INTERPRETER_DETAILS_RE = re.compile(
    r"<details\s+type=\"code_interpreter\"[^>]*>[\s\S]*?</details>\s*",
    re.IGNORECASE,
)
CODE_INTERPRETER_TAG_RE = re.compile(
    r"<code_interpreter\b[^>]*>[\s\S]*?</code_interpreter>\s*",
    re.IGNORECASE,
)
CODE_INTERPRETER_OUTPUT_TAG_RE = re.compile(
    r"<code_interpreter_output\b[^>]*>[\s\S]*?</code_interpreter_output>\s*",
    re.IGNORECASE,
)
EXCESS_BLANK_LINES_RE = re.compile(r"\n{3,}")


@dataclass
class MessageCompactionStats:
    messages_compacted: int = 0
    reasoning_items_removed: int = 0
    reasoning_blocks_removed: int = 0
    code_interpreter_items_removed: int = 0
    code_interpreter_blocks_removed: int = 0
    tool_blocks_removed: int = 0
    content_bytes_removed: int = 0

    def merge(self, other: "MessageCompactionStats") -> None:
        self.messages_compacted += other.messages_compacted
        self.reasoning_items_removed += other.reasoning_items_removed
        self.reasoning_blocks_removed += other.reasoning_blocks_removed
        self.code_interpreter_items_removed += other.code_interpreter_items_removed
        self.code_interpreter_blocks_removed += other.code_interpreter_blocks_removed
        self.tool_blocks_removed += other.tool_blocks_removed
        self.content_bytes_removed += other.content_bytes_removed


@dataclass
class ChatCompactionStats:
    chat_id: str
    title: str
    before_bytes: int
    after_bytes: int
    messages_compacted: int
    reasoning_items_removed: int
    reasoning_blocks_removed: int
    code_interpreter_items_removed: int
    code_interpreter_blocks_removed: int
    tool_blocks_removed: int
    content_bytes_removed: int

    @property
    def bytes_saved(self) -> int:
        return self.before_bytes - self.after_bytes


def extract_message_text_from_output(output: list[dict[str, Any]] | None) -> str:
    if not isinstance(output, list):
        return ""

    parts: list[str] = []
    for item in output:
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for part in item.get("content", []):
            if not isinstance(part, dict):
                continue
            if part.get("type") == "output_text" and isinstance(part.get("text"), str):
                parts.append(part["text"])
            elif isinstance(part.get("text"), str):
                parts.append(part["text"])
    return "\n".join(part for part in parts if part).strip()


def strip_reasoning_details(content: str, output: list[dict[str, Any]] | None) -> tuple[str, int, int]:
    if not isinstance(content, str) or not content:
        return content, 0, 0

    matches = list(REASONING_DETAILS_RE.finditer(content))
    if not matches:
        return content, 0, 0

    stripped = REASONING_DETAILS_RE.sub("", content)
    stripped = EXCESS_BLANK_LINES_RE.sub("\n\n", stripped).strip()

    if not stripped:
        rebuilt = extract_message_text_from_output(output)
        if rebuilt:
            stripped = rebuilt

    return stripped, len(matches), max(0, len(content) - len(stripped))


def strip_code_interpreter_blocks(content: str) -> tuple[str, int, int]:
    if not isinstance(content, str) or not content:
        return content, 0, 0

    matches = 0
    stripped = content
    for pattern in (
        CODE_INTERPRETER_DETAILS_RE,
        CODE_INTERPRETER_TAG_RE,
        CODE_INTERPRETER_OUTPUT_TAG_RE,
    ):
        current_matches = list(pattern.finditer(stripped))
        if not current_matches:
            continue
        matches += len(current_matches)
        stripped = pattern.sub("", stripped)

    stripped = EXCESS_BLANK_LINES_RE.sub("\n\n", stripped).strip()
    return stripped, matches, max(0, len(content) - len(stripped))


def is_tool_block_header(line: str) -> bool:
    normalized = line.strip()
    return (
        normalized.startswith("> **[Tool:")
        or normalized.startswith("> **[Error]**")
        or normalized.startswith("**[Command:")
        or normalized.startswith("**[Patch]")
        or normalized.startswith("**[Agent Tool]")
        or normalized.startswith("**[MCP:")
        or normalized.startswith("[Command:")
    )


def is_fence_line(line: str) -> bool:
    normalized = line.lstrip()
    if normalized.startswith(">"):
        normalized = normalized[1:].lstrip()
    return normalized.startswith("```")


def strip_tool_blocks(content: str) -> tuple[str, int, int]:
    if not isinstance(content, str) or not content:
        return content, 0, 0

    original = content
    lines = content.splitlines()
    kept: list[str] = []
    removed_blocks = 0
    i = 0

    while i < len(lines):
        line = lines[i]
        if not is_tool_block_header(line):
            kept.append(line)
            i += 1
            continue

        removed_blocks += 1
        i += 1
        in_fence = False

        while i < len(lines):
            current = lines[i]
            if in_fence:
                if is_fence_line(current):
                    in_fence = False
                i += 1
                continue

            stripped = current.strip()
            if not stripped:
                i += 1
                continue

            if is_fence_line(current):
                in_fence = True
                i += 1
                continue

            if current.lstrip().startswith(">"):
                i += 1
                continue

            break

    if removed_blocks == 0:
        return original, 0, 0

    stripped = "\n".join(kept)
    stripped = EXCESS_BLANK_LINES_RE.sub("\n\n", stripped).strip()
    return stripped, removed_blocks, max(0, len(original) - len(stripped))


def remove_nonessential_output_items(output: list[dict[str, Any]] | None) -> tuple[list[dict[str, Any]] | None, int, int]:
    if not isinstance(output, list):
        return output, 0, 0

    filtered = []
    reasoning_removed = 0
    code_interpreter_removed = 0
    for item in output:
        if isinstance(item, dict):
            if item.get("type") == "reasoning":
                reasoning_removed += 1
                continue
            if item.get("type") == "open_webui:code_interpreter":
                code_interpreter_removed += 1
                continue
        filtered.append(item)
    return filtered, reasoning_removed, code_interpreter_removed


def current_path_assistant_ids(chat_obj: dict[str, Any], keep_last: int) -> set[str]:
    history = chat_obj.get("history", {}) or {}
    messages = history.get("messages", {}) or {}
    current_id = history.get("currentId")

    path_ids: list[str] = []
    seen: set[str] = set()
    while current_id and current_id not in seen:
        path_ids.append(current_id)
        seen.add(current_id)
        current_id = (messages.get(current_id) or {}).get("parentId")

    path_ids.reverse()
    keep_ids = [
        message_id
        for message_id in path_ids
        if (messages.get(message_id) or {}).get("role") == "assistant"
    ]

    if len(keep_ids) >= keep_last:
        return set(keep_ids[-keep_last:])

    assistants_by_ts = sorted(
        (
            (
                (message.get("timestamp") or 0),
                message_id,
            )
            for message_id, message in messages.items()
            if message.get("role") == "assistant"
        )
    )
    while len(keep_ids) < keep_last and assistants_by_ts:
        _, message_id = assistants_by_ts.pop()
        if message_id not in keep_ids:
            keep_ids.append(message_id)

    return set(keep_ids[-keep_last:])


def compact_assistant_message(message: dict[str, Any]) -> MessageCompactionStats:
    stats = MessageCompactionStats()

    output = message.get("output")
    new_output, removed_reasoning_items, removed_code_interpreter_items = remove_nonessential_output_items(output)
    if removed_reasoning_items > 0 or removed_code_interpreter_items > 0:
        message["output"] = new_output
        stats.reasoning_items_removed += removed_reasoning_items
        stats.code_interpreter_items_removed += removed_code_interpreter_items

    content = message.get("content")
    updated_content = content
    total_content_bytes_removed = 0

    updated_content, removed_reasoning_blocks, reasoning_bytes_removed = strip_reasoning_details(
        updated_content, new_output
    )
    stats.reasoning_blocks_removed += removed_reasoning_blocks
    total_content_bytes_removed += reasoning_bytes_removed

    updated_content, removed_code_blocks, code_bytes_removed = strip_code_interpreter_blocks(updated_content)
    stats.code_interpreter_blocks_removed += removed_code_blocks
    total_content_bytes_removed += code_bytes_removed

    updated_content, removed_tool_blocks, tool_bytes_removed = strip_tool_blocks(updated_content)
    stats.tool_blocks_removed += removed_tool_blocks
    total_content_bytes_removed += tool_bytes_removed

    if updated_content != content:
        message["content"] = updated_content
        stats.content_bytes_removed += total_content_bytes_removed

    if (
        stats.reasoning_items_removed > 0
        or stats.reasoning_blocks_removed > 0
        or stats.code_interpreter_items_removed > 0
        or stats.code_interpreter_blocks_removed > 0
        or stats.tool_blocks_removed > 0
        or stats.content_bytes_removed > 0
    ):
        stats.messages_compacted += 1

    return stats


def compact_chat_object(chat_obj: dict[str, Any], keep_last_assistant: int) -> tuple[dict[str, Any], MessageCompactionStats]:
    keep_ids = current_path_assistant_ids(chat_obj, keep_last_assistant)
    stats = MessageCompactionStats()

    history_messages = chat_obj.get("history", {}).get("messages", {}) or {}
    for message_id, message in history_messages.items():
        if message.get("role") != "assistant" or message_id in keep_ids:
            continue
        stats.merge(compact_assistant_message(message))

    if isinstance(chat_obj.get("messages"), list):
        for message in chat_obj["messages"]:
            if not isinstance(message, dict):
                continue
            if message.get("role") != "assistant" or message.get("id") in keep_ids:
                continue
            stats.merge(compact_assistant_message(message))

    return chat_obj, stats


def iterate_compaction(conn: sqlite3.Connection, keep_last_assistant: int, apply: bool) -> list[ChatCompactionStats]:
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT id, title, chat FROM chat").fetchall()
    chat_stats: list[ChatCompactionStats] = []

    for row in rows:
        raw_chat = row["chat"]
        chat_obj = json.loads(raw_chat)
        before = len(raw_chat.encode("utf-8"))
        compacted_chat, message_stats = compact_chat_object(chat_obj, keep_last_assistant)
        changed = (
            message_stats.messages_compacted > 0
            or message_stats.reasoning_items_removed > 0
            or message_stats.reasoning_blocks_removed > 0
            or message_stats.code_interpreter_items_removed > 0
            or message_stats.code_interpreter_blocks_removed > 0
            or message_stats.tool_blocks_removed > 0
            or message_stats.content_bytes_removed > 0
        )
        new_raw = (
            json.dumps(compacted_chat, ensure_ascii=False, separators=(",", ":"))
            if changed
            else raw_chat
        )
        after = len(new_raw.encode("utf-8"))

        stat = ChatCompactionStats(
            chat_id=row["id"],
            title=row["title"] or "(untitled)",
            before_bytes=before,
            after_bytes=after,
            messages_compacted=message_stats.messages_compacted,
            reasoning_items_removed=message_stats.reasoning_items_removed,
            reasoning_blocks_removed=message_stats.reasoning_blocks_removed,
            code_interpreter_items_removed=message_stats.code_interpreter_items_removed,
            code_interpreter_blocks_removed=message_stats.code_interpreter_blocks_removed,
            tool_blocks_removed=message_stats.tool_blocks_removed,
            content_bytes_removed=message_stats.content_bytes_removed,
        )
        if changed:
            chat_stats.append(stat)

        if apply and changed:
            conn.execute("UPDATE chat SET chat = ? WHERE id = ?", (new_raw, row["id"]))

    if apply:
        conn.commit()
        conn.execute("VACUUM")

    return sorted(chat_stats, key=lambda item: item.bytes_saved, reverse=True)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compact old OpenWebUI reasoning blocks while keeping the latest assistant reasoning."
    )
    parser.add_argument("--db", required=True, help="Path to OpenWebUI webui.db")
    parser.add_argument(
        "--keep-last-assistant",
        type=int,
        default=2,
        help="Number of latest assistant turns to keep reasoning for per chat (default: 2)",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply changes in place. Without this flag the script performs a dry run.",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=10,
        help="How many top savings rows to print (default: 10)",
    )
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        raise SystemExit(f"DB not found: {db_path}")

    conn = sqlite3.connect(str(db_path))
    try:
        stats = iterate_compaction(conn, args.keep_last_assistant, args.apply)
    finally:
        conn.close()

    total_before = sum(item.before_bytes for item in stats)
    total_after = sum(item.after_bytes for item in stats)
    total_saved = total_before - total_after
    total_messages = sum(item.messages_compacted for item in stats)
    total_reasoning_items = sum(item.reasoning_items_removed for item in stats)
    total_reasoning_blocks = sum(item.reasoning_blocks_removed for item in stats)
    total_code_interpreter_items = sum(item.code_interpreter_items_removed for item in stats)
    total_code_interpreter_blocks = sum(item.code_interpreter_blocks_removed for item in stats)
    total_tool_blocks = sum(item.tool_blocks_removed for item in stats)

    mode = "APPLY" if args.apply else "DRY RUN"
    print(f"[{mode}] chats_changed={len(stats)}")
    print(
        f"[{mode}] bytes_before={total_before} bytes_after={total_after} bytes_saved={total_saved}"
    )
    print(
        f"[{mode}] messages_compacted={total_messages} reasoning_items_removed={total_reasoning_items} reasoning_blocks_removed={total_reasoning_blocks} code_interpreter_items_removed={total_code_interpreter_items} code_interpreter_blocks_removed={total_code_interpreter_blocks} tool_blocks_removed={total_tool_blocks}"
    )
    print("")
    print("Top savings:")
    for item in stats[: args.top]:
        print(
            f"- {item.title} ({item.chat_id}): "
            f"saved={item.bytes_saved}B messages={item.messages_compacted} "
            f"reasoning_items={item.reasoning_items_removed} reasoning_blocks={item.reasoning_blocks_removed} "
            f"code_items={item.code_interpreter_items_removed} code_blocks={item.code_interpreter_blocks_removed} tool_blocks={item.tool_blocks_removed}"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
