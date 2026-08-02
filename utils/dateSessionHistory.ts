/**
 * 见面（DateApp）会话历史的窗口计算。
 * 纯函数，不碰 DB / React —— 调用方负责真正取数与设状态。
 */

/**
 * 把历史裁到目标消息为止（含它）。
 *
 * 重掷用的历史是「全来源」的最近窗口（见面 + 聊天混在一起），而被重掷的那一轮 user 消息
 * 是从见面子集里挑的。两者之间要是夹了更新的普通聊天消息，尾巴就不是目标那条了——而
 * 提示词构建固定砍掉最后一条（本意是砍掉待重发的 user），会连锅端错。裁到目标为止即可
 * 让两边对齐。目标不在列表里时原样返回，不把历史裁没。
 */
export const trimHistoryThrough = <T extends { id: number }>(msgs: T[], targetId: number): T[] => {
  const index = msgs.findIndex((m) => m.id === targetId);
  return index === -1 ? msgs : msgs.slice(0, index + 1);
};

export interface NovelLoadMorePlan {
  /** 阅读模式下一步显示多少条。 */
  nextVisibleCount: number;
  /** 需要回库里重取时的新 limit；只需开窗则为 null。 */
  nextLoadLimit: number | null;
}

/**
 * 阅读模式点「加载更早」时该做什么。
 *
 * 会话只加载最近一窗见面消息，阅读模式在这一窗上开显示窗口。窗口铺满已加载的部分后
 * 必须回库里取更早的行，否则更早的见面记录在阅读模式里永远够不着。
 */
export const planNovelLoadMore = (input: {
  /** 当前已从库里加载的见面消息条数。 */
  loadedCount: number;
  /** 阅读模式当前显示条数。 */
  visibleCount: number;
  /** 每次多显示多少条。 */
  windowStep: number;
  /** 当前查询用的 limit。 */
  loadLimit: number;
  /** 回库重取时 limit 加多少。 */
  loadStep: number;
  /** 上次取数是否已经把库里的见面记录取完了。 */
  reachedDbEnd: boolean;
}): NovelLoadMorePlan => {
  const { loadedCount, visibleCount, windowStep, loadLimit, loadStep, reachedDbEnd } = input;

  // 本地还有没显示出来的，先开窗，不查库。
  if (visibleCount < loadedCount) {
    return {
      nextVisibleCount: Math.min(visibleCount + windowStep, loadedCount),
      nextLoadLimit: null,
    };
  }

  // 已加载的全显示完了：库里还有就再取一批，取完了就停在原地。
  if (reachedDbEnd) {
    return { nextVisibleCount: visibleCount, nextLoadLimit: null };
  }
  return {
    nextVisibleCount: visibleCount + windowStep,
    nextLoadLimit: loadLimit + loadStep,
  };
};
