export interface DiaryOffer {
  userId: number;
  text: string;
  source: "text" | "voice";
}

// Сообщения, которые коуч предложил записать в дневник (кнопка «📝 Записать в дневник»).
// В callback_data влезает только номер, сам текст живёт здесь — в памяти процесса,
// не больше maxSize последних предложений; после рестарта бота кнопка устаревает.
export class DiaryOfferStore {
  private readonly offers = new Map<number, DiaryOffer>();
  private nextId = 1;

  constructor(private readonly maxSize = 500) {}

  add(userId: number, text: string, source: DiaryOffer["source"]): number {
    const id = this.nextId++;
    this.offers.set(id, { userId, text, source });
    // Map хранит порядок вставки — первым идёт самое старое предложение.
    while (this.offers.size > this.maxSize) {
      const oldest = this.offers.keys().next().value;
      if (oldest === undefined) break;
      this.offers.delete(oldest);
    }
    return id;
  }

  // Одноразово: повторное нажатие (или чужая кнопка) ничего не запишет второй раз.
  take(id: number, userId: number): DiaryOffer | undefined {
    const offer = this.offers.get(id);
    if (!offer || offer.userId !== userId) return undefined;
    this.offers.delete(id);
    return offer;
  }

  get size(): number {
    return this.offers.size;
  }
}
