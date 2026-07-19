"""幂等补丁：修复 xiaohongshu-skills 长文模式正文写入到错误编辑器的问题。

上游 publish_long_article.py 复用了普通图文的 div.ql-editor；小红书长文页实际使用
contenteditable/ProseMirror 编辑器，导致标题写入成功但正文始终为 0 字。

本补丁会替换 _fill_long_content：
1. 从可见 contenteditable/ProseMirror/role=textbox 中选择面积最大的正文编辑器；
2. 排除 input/textarea 与标题区域；
3. 用现有 CDP 键盘输入；
4. 回读文本，正文为空时明确失败，禁止继续排版或发布。
"""

from __future__ import annotations

import sys
from pathlib import Path

PATCH_MARKER = "SULLY_LONG_EDITOR_PATCH_V2"
START = "def _fill_long_content(page: Page, content: str) -> None:\n"
END = "\ndef _insert_images_to_editor(page: Page, image_paths: list[str]) -> None:\n"

REPLACEMENT = '''def _fill_long_content(page: Page, content: str) -> None:
    """通过页面可见提示点击正文区，并对当前焦点发送真实键盘输入。"""
    if not content.strip():
        raise PublishError("长文正文为空，已停止发布")

    # SULLY_LONG_EDITOR_PATCH_V2：不依赖 ql-editor / ProseMirror 等易变 class。
    target = page.evaluate(
        r"""
        (() => {
            const hint = '输入文字，内容将自动保存';
            const visible = (el) => {
                const r = el.getBoundingClientRect();
                const s = getComputedStyle(el);
                return r.width > 20 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden';
            };
            const nodes = Array.from(document.querySelectorAll('body *')).filter((el) =>
                visible(el) && ((el.textContent || '').trim().includes(hint) ||
                    String(el.getAttribute('placeholder') || '').includes('输入文字'))
            );
            nodes.sort((a, b) => {
                const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
                return (ar.width * ar.height) - (br.width * br.height);
            });
            const hintEl = nodes[0] || null;
            if (!hintEl) return null;
            const r = hintEl.getBoundingClientRect();
            return {
                x: Math.max(r.left + 8, Math.min(r.right - 8, r.left + r.width / 2)),
                y: Math.max(r.top + 8, Math.min(r.bottom - 8, r.top + Math.min(r.height / 2, 40))),
                tag: hintEl.tagName,
                className: String(hintEl.className || ''),
                text: (hintEl.textContent || '').trim().slice(0, 120)
            };
        })()
        """
    )
    if not target:
        diagnostic = page.evaluate(
            r"""
            (() => Array.from(document.querySelectorAll('[contenteditable], [role="textbox"], textarea, input'))
                .filter(el => {
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                })
                .slice(0, 12)
                .map(el => ({
                    tag: el.tagName,
                    role: el.getAttribute('role'),
                    editable: el.getAttribute('contenteditable'),
                    placeholder: el.getAttribute('placeholder'),
                    cls: String(el.className || '').slice(0, 100)
                })))()
            """
        )
        raise PublishError(f"未找到长文正文提示区域；页面候选元素: {diagnostic}")

    logger.info("长文正文点击目标: %s", target)
    page.mouse_click(target["x"], target["y"])
    time.sleep(0.3)

    focus_before = page.evaluate(
        r"""
        (() => {
            const el = document.activeElement;
            return el ? {
                tag: el.tagName,
                role: el.getAttribute('role'),
                editable: el.getAttribute('contenteditable'),
                cls: String(el.className || '').slice(0, 120)
            } : null;
        })()
        """
    )
    logger.info("长文输入前焦点: %s", focus_before)

    # 对页面当前焦点输入，不再先用 CSS selector 重新 focus 到错误元素。
    page._send_session("Input.dispatchKeyEvent", {"type": "keyDown", "key": "a", "code": "KeyA", "modifiers": 2})
    page._send_session("Input.dispatchKeyEvent", {"type": "keyUp", "key": "a", "code": "KeyA", "modifiers": 2})
    page.press_key("Backspace")
    for char in content:
        if char == "\\n":
            page.press_key("Enter")
        else:
            page._send_session("Input.dispatchKeyEvent", {"type": "keyDown", "text": char})
            page._send_session("Input.dispatchKeyEvent", {"type": "keyUp", "text": char})
    time.sleep(0.8)

    verification = page.evaluate(
        f"""
        (() => {{
            const bodyText = document.body ? (document.body.innerText || '') : '';
            const matches = Array.from(bodyText.matchAll(/字数[：:]?[^0-9]*([0-9]+)/g));
            const counts = matches.map(m => Number(m[1])).filter(Number.isFinite);
            const active = document.activeElement;
            const activeText = active ? (active.innerText || active.textContent || active.value || '') : '';
            const probe = {json.dumps(content.strip()[:12])};
            return {{
                count: counts.length ? Math.max(...counts) : null,
                activeTextLength: activeText.trim().length,
                bodyContainsProbe: probe ? bodyText.includes(probe) : false,
                activeTag: active ? active.tagName : null
            }};
        }})()
        """
    ) or {}
    logger.info("长文正文写入验收: %s", verification)
    count = verification.get("count")
    if not ((isinstance(count, (int, float)) and count > 0) or
            verification.get("activeTextLength", 0) > 0 or
            verification.get("bodyContainsProbe")):
        raise PublishError(f"长文正文写入后仍为 0 字，已停止发布；焦点={focus_before}，验收={verification}")

    logger.info("已填写长文正文 (%d 字)", len(content))
    time.sleep(1)
'''


def find_target() -> Path | None:
    here = Path(__file__).resolve().parent
    candidates: list[Path] = []
    for base in [here, *here.parents]:
        for name in ("xiaohongshu-skills", "xiaohongshu-skills-main"):
            candidates.append(base / name / "scripts" / "xhs" / "publish_long_article.py")
        candidates.append(base / "scripts" / "xhs" / "publish_long_article.py")
    return next((p for p in candidates if p.is_file()), None)


def apply_patch(target: Path) -> int:
    text = target.read_text(encoding="utf-8")
    if PATCH_MARKER in text:
        print(f"[skip] {target} 长文正文补丁已存在。")
        return 0
    start = text.find(START)
    end = text.find(END, start + len(START)) if start >= 0 else -1
    if start < 0 or end < 0:
        print(f"[error] {target} 中找不到 _fill_long_content 函数边界；可能上游已变更。")
        return 2
    patched = text[:start] + REPLACEMENT + text[end:]
    backup = target.with_suffix(target.suffix + ".bak-sully-long")
    if not backup.exists():
        backup.write_text(text, encoding="utf-8")
        print(f"  [bak] {backup.name}")
    target.write_text(patched, encoding="utf-8")
    print(f"[done] {target} 长文正文补丁已应用。")
    return 0


def main() -> int:
    if len(sys.argv) > 1:
        target = Path(sys.argv[1]).expanduser().resolve()
        if not target.is_file():
            print(f"[error] 文件不存在: {target}")
            return 2
    else:
        target = find_target()
        if target is None:
            print("[error] 找不到 xiaohongshu-skills/scripts/xhs/publish_long_article.py")
            return 2
    return apply_patch(target)


if __name__ == "__main__":
    raise SystemExit(main())
