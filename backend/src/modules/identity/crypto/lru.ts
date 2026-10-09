// A least recently used cache: a hash map for O(1) lookup plus a doubly linked list for O(1) recency
// updates. It backs the JWKS key cache, where a bounded size caps memory and the most recently used
// keys stay hot while a key rotation is in flight. Hand-rolled to keep the dependency list short.
interface Node<K, V> {
  key: K;
  value: V;
  prev: Node<K, V> | null;
  next: Node<K, V> | null;
}

export class LruCache<K, V> {
  private readonly capacity: number;
  private readonly nodes = new Map<K, Node<K, V>>();
  private head: Node<K, V> | null = null; // most recently used
  private tail: Node<K, V> | null = null; // least recently used

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`LruCache capacity must be a whole number of at least 1, got ${capacity}`);
    }
    this.capacity = capacity;
  }

  get size(): number {
    return this.nodes.size;
  }

  has(key: K): boolean {
    return this.nodes.has(key);
  }

  get(key: K): V | undefined {
    const node = this.nodes.get(key);
    if (!node) return undefined;
    this.moveToFront(node);
    return node.value;
  }

  set(key: K, value: V): void {
    const existing = this.nodes.get(key);
    if (existing) {
      existing.value = value;
      this.moveToFront(existing);
      return;
    }
    const node: Node<K, V> = { key, value, prev: null, next: null };
    this.nodes.set(key, node);
    this.pushFront(node);
    if (this.nodes.size > this.capacity && this.tail) {
      const evicted = this.tail;
      this.unlink(evicted);
      this.nodes.delete(evicted.key);
    }
  }

  delete(key: K): boolean {
    const node = this.nodes.get(key);
    if (!node) return false;
    this.unlink(node);
    this.nodes.delete(key);
    return true;
  }

  keys(): K[] {
    const out: K[] = [];
    for (let node = this.head; node; node = node.next) out.push(node.key);
    return out;
  }

  private pushFront(node: Node<K, V>): void {
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  private unlink(node: Node<K, V>): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = null;
    node.next = null;
  }

  private moveToFront(node: Node<K, V>): void {
    if (this.head === node) return;
    this.unlink(node);
    this.pushFront(node);
  }
}
