// Собирает части альбома Telegram (сообщения с одним media_group_id) в одну пачку.
// Telegram присылает фото альбома отдельными обновлениями почти одновременно; пачка
// отдаётся в onFlush, когда delayMs подряд не приходило новых частей.
//
// Ждать в самом обработчике сообщения нельзя: обновления одного чата идут строго по
// очереди (sequentialize), и следующая часть альбома не придёт, пока обработчик не
// завершится. Поэтому обработчик только кладёт часть в буфер, а onFlush вызывается
// по таймеру уже вне цепочки middleware — ошибки onFlush он должен обрабатывать сам.
export class MediaGroupBuffer<T> {
  private readonly groups = new Map<string, { items: T[]; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly delayMs: number,
    private readonly onFlush: (items: T[]) => Promise<void>,
  ) {}

  add(key: string, item: T): void {
    const group = this.groups.get(key);
    if (group) {
      clearTimeout(group.timer);
      group.items.push(item);
      group.timer = this.schedule(key);
      return;
    }
    this.groups.set(key, { items: [item], timer: this.schedule(key) });
  }

  private schedule(key: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const group = this.groups.get(key);
      if (!group) return;
      this.groups.delete(key);
      this.onFlush(group.items).catch((err: unknown) => {
        console.error("Не удалось обработать альбом:", err);
      });
    }, this.delayMs);
  }
}
