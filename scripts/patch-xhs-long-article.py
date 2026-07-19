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

PATCH_MARKER = "data-sully-long-editor"
START = "def _fill_long_content(page: Page, content: str) -> None:\n"
END = "\ndef _insert_images_to_editor(page: Page, image_paths: list[str]) -> None:\n"

REPLACEMENT = '''def _fill_long_content(page: Page, content: str) -> None:
    """填写长文正文，并在继续排版前确认文字确实进入编辑器。"""
    if not content.strip():
        raise PublishError("长文正文为空，已停止发布")

    selector = '[data-sully-long-editor="true"]'
    found = page.evaluate(
        f"""
        (() => {{
            const candidates = Array.from(document.querySelectorAll(
                '[contenteditable="true"], .ProseMirror, [role="textbox"]'
            ));
            const visible = candidates.filter((el) => {{
                if (el.matches('input, textarea')) return false;
                if (el.closest('textarea, .title-container')) return false;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 100 && rect.height > 40 &&
                    style.display !== 'none' && style.visibility !== 'hidden';
            }});
            visible.sort((a, b) => {{
                const ar = a.getBoundingClientRect();
                const br = b.getBoundingClientRect();
                return (br.width * br.height) - (ar.width * ar.height);
            }});
            const editor = visible[0];
            if (!editor) return null;
            document.querySelectorAll('[data-sully-long-editor]').forEach(
                (el) => el.removeAttribute('data-sully-long-editor')
            );
            editor.setAttribute('data-sully-long-editor', 'true');
            const rect = editor.getBoundingClientRect();
            return {{ tag: editor.tagName, className: String(editor.className || ''), width: rect.width, height: rect.height }};
        }})()
        """
    )
    if not found:
        raise PublishError("未找到长文正文编辑器，小红书页面结构可能已变化")

    logger.info("长文正文编辑器: %s", found)
    page.input_content_editable(selector, content)
    time.sleep(0.5)

    written = page.evaluate(
        f"""
        (() => {{
            const el = document.querySelector({json.dumps(selector)});
            return el ? (el.innerText || el.textContent || '').trim() : '';
        }})()
        """
    ) or ""
    if not written.strip():
        raise PublishError("长文正文写入失败（页面仍显示 0 字），已停止发布")

    logger.info("已填写长文正文 (%d 字，页面回读 %d 字)", len(content), len(written))
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
