import { describe, expect, it } from 'vitest';
import { formatRoleEventNotification } from './roleEventNotification';

describe('role event notification copy', () => {
  it('uses role name and message copy', () => {
    expect(formatRoleEventNotification({ charName: '阿澄', kind: 'message', tag: 'm1' })).toMatchObject({ title: '阿澄', body: '给你发了一条消息' });
  });
  it('previews other-side and task names', () => {
    expect(formatRoleEventNotification({ charName: '阿澄', kind: 'other_side', name: '雨夜车站', tag: 'o1' }).body).toBe('刚刚去了「雨夜车站」');
    expect(formatRoleEventNotification({ charName: '阿澄', kind: 'task', name: '整理房间', tag: 't1' }).body).toBe('完成了「整理房间」');
  });
  it('falls back to short copy without a name', () => {
    expect(formatRoleEventNotification({ charName: '阿澄', kind: 'other_side', tag: 'o2' }).body).toBe('刚刚去彼方了');
    expect(formatRoleEventNotification({ kind: 'error', tag: 'e1' })).toMatchObject({ title: 'SullyOS', body: '刚才没能联系上你' });
  });
});
