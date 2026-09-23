/**
 * Minimale Job-Sicht, die den Prozessoren genügt. Sowohl BullMQs `Job` als
 * auch die Jobs der lokalen SQLite-Queue erfüllen diese Form strukturell,
 * sodass dieselben Prozessoren in beiden Modi laufen.
 */
export interface JobLike<T> {
  data: T;
  name?: string;
  id?: string;
}
