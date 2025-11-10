import assert from 'node:assert';
import fs from 'node:fs';
import { Player } from './player.js';

/**
 * Deferred promise utility for storing promises to be resolved later.
 * Allows external resolution of a promise after creation.
 * 
 * @template T the type of value the promise will resolve to
 */
class Deferred<T> {
    public readonly promise: Promise<T>;
    public resolve!: (value: T) => void;
    public reject!: (reason?: unknown) => void;

     // Rep invariant:
    //   - promise is a valid Promise<T>
    //   - resolve and reject are functions assigned during construction
    //
    // Abstraction function:
    //   AF(promise, resolve, reject) = A deferred promise that can be resolved or rejected
    //     externally using the resolve/reject methods. The promise field contains the
    //     underlying Promise<T> that will be fulfilled when resolve() or reject() is called.
    //
    // Safety from rep exposure:
    //   - promise field is readonly and exposed, but Promises are immutable once created
    //   - resolve and reject are functions (immutable references), and their invocation
    //     only affects the internal promise state, not the Deferred object itself
    //   - No mutable objects are exposed to clients

    /**
     * Create a new deferred promise.
     * The promise can be resolved or rejected later using the resolve/reject methods.
     */
    public constructor() {
        this.promise = new Promise<T>((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }
}

/**
 * Mutable ADT representing a Memory Scramble game board.
 * 
 * A board is a rows×cols grid where each cell either:
 *   - holds a card with a picture (string)
 *   - is empty (null)
 * 
 * Each card can be face-up or face-down. Face-up cards are controlled by
 * the player who flipped them. Empty cells are always face-down with no controller.
 */

export class Board {
    private readonly rows: number;
    private readonly cols: number;
    private readonly cards: (string | null)[][];
    private readonly faceUp: boolean[][];
    private readonly controller: (string | null)[][];
    private readonly players: Map<string, Player>;
    // Track pending control attempts for each cell
    private readonly waitingForControl: Map<string, Deferred<void>[]>;
    private readonly lingering: Map<string, Array<{ row: number; col: number }>>;
    private readonly changeResolvers: Map<string, ((value: string) => void)[]> = new Map();
    
    // Rep invariant:
    //   - rows, cols are positive integers (>= 1)
    //   - cards, faceUp, controller are all rows×cols 2D arrays
    //   - for all r,c: if cards[r][c] is null, then faceUp[r][c] is false and controller[r][c] is null
    //   - for all r,c: if cards[r][c] is a string, it's nonempty with no whitespace
    //   - for all r,c: if controller[r][c] is not null, it exists as a key in players map
    //   - waitingForControl maps "row,col" strings to arrays of Deferred<void>
    //   - lingering maps player ids to arrays of {row, col} positions
    //   - changeResolvers maps player ids to arrays of callback functions
    //   - all player ids in players map are nonempty strings with no whitespace
    //
    // Abstraction function:
    //   AF(rows, cols, cards, faceUp, controller, players, waitingForControl, lingering, changeResolvers) =
    //     A game board with dimensions rows×cols where:
    //     - cards[r][c] is the picture at position (r,c), or null if empty
    //     - faceUp[r][c] indicates if card at (r,c) is face-up
    //     - controller[r][c] is the player id who controls the face-up card at (r,c), or null
    //     - players maps player ids to Player objects tracking game statistics and state
    //     - waitingForControl tracks which players are blocked waiting to flip specific cards
    //     - lingering tracks face-up uncontrolled cards that should be flipped down per player
    //     - changeResolvers tracks watchers waiting for the next board state change
    //
    // Safety from rep exposure:
    //   - All fields are private and readonly references (though the objects they point to are mutable)
    //   - Constructor deep-copies the layout array into cards[][], creating new array objects
    //   - numRows() and numCols() return immutable primitives
    //   - pictureAt() returns string | null (immutable)
    //   - isFaceUp() returns boolean (immutable primitive)
    //   - controllerAt() returns string | null (immutable)
    //   - listPlayers() returns a fresh array created by Array.from()
    //   - render() returns a string (immutable)
    //   - picturesDump() returns a string (immutable)
    //   - registerPlayer() returns Player objects that are in the internal map, but Player
    //     is also an ADT with its own rep invariant and safety from rep exposure
    //   - getFirstCard() and getSecondCard() in Player return defensive copies: { ...this.card }
    //   - No methods return direct references to cards[][], faceUp[][], controller[][],
    //     waitingForControl, lingering, or changeResolvers maps
    //   - addChangeWatcher() accepts callback functions but stores them internally;
    //     clients cannot access the changeResolvers map
    //   - map() mutates cards in place but is a controlled operation that maintains invariants

    /**
     * Create a new board with the given layout.
     * 
     * @param rows number of rows (must be >= 1)
     * @param cols number of columns (must be >= 1)
     * @param layout array of length rows*cols containing card pictures (or null for empty cells),
     *               in row-major order
     */
    private constructor(rows: number, cols: number, layout: readonly (string | null)[]) {
        this.rows = rows;
        this.cols = cols;
        this.cards = [];
        this.faceUp = [];
        this.controller = [];
        this.players = new Map();
        this.waitingForControl = new Map();
        this.lingering = new Map();
        
        let k = 0;
        for (let r = 0; r < rows; r++) {
            const rc: (string | null)[] = [];
            const ru: boolean[] = [];
            const rctrl: (string | null)[] = [];
            for (let c = 0; c < cols; c++) {
                rc.push(layout[k++] ?? null);
                ru.push(false);
                rctrl.push(null);
            }
            this.cards.push(rc);
            this.faceUp.push(ru);
            this.controller.push(rctrl);
        }
        this.checkRep();

    }

    /**
     * Assert the representation invariant.
     * @throws Error if rep invariant is violated
     */
    private checkRep(): void {
    assert(Number.isInteger(this.rows) && this.rows >= 1);
    assert(Number.isInteger(this.cols) && this.cols >= 1);

    assert(this.cards.length === this.rows);
    assert(this.faceUp.length === this.rows);
    assert(this.controller.length === this.rows);

    for (let r = 0; r < this.rows; r++) {
        const cardsRow = this.cards[r];
        const faceUpRow = this.faceUp[r];
        const controllerRow = this.controller[r];
        
        assert(cardsRow !== undefined && cardsRow.length === this.cols);
        assert(faceUpRow !== undefined && faceUpRow.length === this.cols);
        assert(controllerRow !== undefined && controllerRow.length === this.cols);

        for (let c = 0; c < this.cols; c++) {
            const card = cardsRow[c];
            const up = faceUpRow[c];
            const ctrl = controllerRow[c];

            if (card === null) {
                assert(up === false);
                assert(ctrl === null);
            } else {
                assert(typeof card === 'string' && card.length > 0);
                assert(!/\s/.test(card)); // no whitespace inside a picture
                assert(ctrl === null || (typeof ctrl === 'string' && this.players.has(ctrl)));
            }
        }
    }

    // Check all player ids are nonempty strings with no whitespace
    for (const playerId of this.players.keys()) {
        assert(typeof playerId === 'string' && playerId.length > 0);
        assert(!/\s/.test(playerId));
    }

    // Check waitingForControl keys are valid "row,col" format
    for (const key of this.waitingForControl.keys()) {
        const parts = key.split(',');
        assert(parts.length === 2);
        const row = Number(parts[0]);
        const col = Number(parts[1]);
        assert(Number.isInteger(row) && row >= 0 && row < this.rows);
        assert(Number.isInteger(col) && col >= 0 && col < this.cols);
    }

    // Check lingering maps player ids to valid position arrays
    for (const [playerId, positions] of this.lingering.entries()) {
        assert(this.players.has(playerId));
        assert(Array.isArray(positions));
        for (const pos of positions) {
            assert(Number.isInteger(pos.row) && pos.row >= 0 && pos.row < this.rows);
            assert(Number.isInteger(pos.col) && pos.col >= 0 && pos.col < this.cols);
        }
    }

    // Check changeResolvers maps player ids to function arrays
    for (const [playerId, resolvers] of this.changeResolvers.entries()) {
        assert(this.players.has(playerId));
        assert(Array.isArray(resolvers));
        for (const resolver of resolvers) {
            assert(typeof resolver === 'function');
        }
    }
}

    /**
     * Apply a transformation function to all cards on the board.
     * Empty cells remain unchanged. The transformation is atomic - the board
     * remains consistent throughout the operation.
     * 
     * @param f async transformation function from old picture to new picture
     * @returns promise that resolves when all transformations are complete
     */
    public async map(f: (card: string) => Promise<string>): Promise<void> {
        for (let r = 0; r < this.rows; r++) {
            const cardsRow = this.cards[r];
            if (!cardsRow) continue;
            for (let c = 0; c < this.cols; c++) {
                const pic = cardsRow[c];
                if (pic !== null && pic !== undefined) {
                    cardsRow[c] = await f(pic);
                }
            }
        }
        this.checkRep();
        this.notifyChange();
    }

    /**
     * Register a callback to be notified when the board state changes.
     * The callback will be invoked with the updated board state (as seen by the player)
     * @param playerId identifier of the player watching for changes
     * @param resolver callback function that receives the updated board state as a string
     */
    public addChangeWatcher(playerId: string, resolver: (value: string) => void): void {
    let list = this.changeResolvers.get(playerId);
    if (!list) {
        list = [];
        this.changeResolvers.set(playerId, list);
    }
    list.push(resolver);
}
    /**
     * Notify all registered watchers of a board state change.
     * Each watcher receives the current board state from their perspective.
     * All watchers are automatically cleared after notification (one-time notification).
     */
    private notifyChange(): void {
        for (const [playerId, resolvers] of this.changeResolvers.entries()) {
            const state = this.render(playerId);
            for (const resolve of resolvers) {
                resolve(state);
            }
        }
        this.changeResolvers.clear();
    }

    /**
     * Get the number of rows on this board.
     * @returns number of rows (>= 1)
     */
    public numRows(): number { return this.rows; }

    /**
     * Get the number of columns on this board.
     * @returns number of columns (>= 1)
     */
    public numCols(): number { return this.cols; }

    /**
     * Get the picture at a specific position.
     * 
     * @param row row index (0-based)
     * @param col column index (0-based)
     * @returns the picture string at (row, col), or null if the cell is empty
     * @throws Error if row or col are out of bounds
     */
    public pictureAt(row: number, col: number): string | null {
        this.requireInBounds(row, col);
        const cardsRow = this.cards[row];
        if (!cardsRow) throw new Error('invalid row');
        return cardsRow[col] ?? null;
    }

    /**
     * Check if a card is face-up.
     * 
     * @param row row index (0-based)
     * @param col column index (0-based)
     * @returns true if the card at (row, col) is face-up, false otherwise
     * @throws Error if row or col are out of bounds
     */
    public isFaceUp(row: number, col: number): boolean {
        this.requireInBounds(row, col);
        const faceUpRow = this.faceUp[row];
        if (!faceUpRow) throw new Error('invalid row');
        const value = faceUpRow[col];
        return value ?? false;
    }

    /**
     * Record a card position that should be cleaned up later for a specific player.
     * This method tracks cards that are face-up but uncontrolled after a failed second card flip
     * (rules 2-A or 2-B), so they can be flipped down during the next first card flip (rule 3-B).
     * 
     * @param playerId the id of the player whose lingering card should be remembered
     * @param row the row index of the lingering card (0-based)
     * @param col the column index of the lingering card (0-based)
     */
    private rememberLingering(playerId: string, row: number, col: number): void {
        const list = this.lingering.get(playerId) ?? [];
        list.push({ row, col });
        this.lingering.set(playerId, list);
    }


    /**
     * Get the player controlling a card.
     * 
     * @param row row index (0-based)
     * @param col column index (0-based)
     * @returns the player id controlling the card at (row, col), or null if no controller
     * @throws Error if row or col are out of bounds
     */
    public controllerAt(row: number, col: number): string | null {
        this.requireInBounds(row, col);
        const controllerRow = this.controller[row];
        if (!controllerRow) throw new Error('invalid row');
        return controllerRow[col] ?? null;
    }

    /**
     * Dump the board layout in the same format as the board file.
     * 
     * @returns string representation of the board in file format:
     *          first line is "rows×cols", followed by one card per line in row-major order
     */
    public picturesDump(): string {
        const out: string[] = [`${this.rows}x${this.cols}`];
        for (let r = 0; r < this.rows; r++) {
            const cardsRow = this.cards[r];
            if (!cardsRow) continue;
            for (let c = 0; c < this.cols; c++) {
                out.push(cardsRow[c] ?? 'none');
            }
        }
        return out.join('\n') + '\n';
    }

    /**
     * Get a string representation for debugging.
     * @returns string describing this board
     */
    public toString(): string {
        return `Board(${this.rows}x${this.cols})`;
    }


    /**
     * Register a player or retrieve an existing player.
     * 
     * @param id unique player identifier (nonempty, no whitespace)
     * @param displayName human-readable name for the player (defaults to id)
     * @returns the Player object for this id (existing or newly created)
     * @throws Error if id is empty or contains whitespace
     */
    public registerPlayer(id: string, displayName = id): Player {
        if (id.length === 0 || /\s/.test(id)) throw new Error('player id must be nonempty, no whitespace');
        const existing = this.players.get(id);
        if (existing) return existing;
        const p = new Player(id);
        this.players.set(id, p);
        this.checkRep();
        return p;
    }

    /**
     * List all registered player ids.
     * @returns array of player ids (in insertion order)
     */
    public listPlayers(): string[] {
        return Array.from(this.players.keys());
    }

  // =======================
  // Card flipping 
  // =======================

    /**
     * Render the current board state as a textual representation from a player's perspective.
     * 
     * @param playerId identifier of the player viewing the board
     * @returns string representation of the board state, with newline-separated rows
     */
    public render(playerId: string): string {
        const rows = this.rows, cols = this.cols;
        const lines: string[] = [`${rows}x${cols}`];
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const pic = this.pictureAt(r, c);
                if (pic === null) {
                lines.push('none');
                } else if (!this.isFaceUp(r, c)) {
                    lines.push('down');
                } else {
                    const ctrl = this.controllerAt(r, c); // playerId or null
                    lines.push(`${ctrl === playerId ? 'my' : 'up'} ${pic}`);
                }
            }
        }
        return lines.join('\n') + '\n';
    }

    /**
     * Flip a card face-up and assign control to a player (asynchronous version).
     * Implements the game rules for first and second card flips.
     * 
     * @param playerId id of the player flipping the card
     * @param row row index of the card (0-based)
     * @param col column index of the card (0-based)
     * @throws Error if:
     *         - row or col are out of bounds
     *         - playerId is not registered
     *         - the cell is empty (rules 1-A or 2-A)
     *         - second card is face up and controlled (rule 2-B)
     *         - trying to flip the same card twice
     */

    public async flipUp(playerId: string, row: number, col: number): Promise<void> {
    this.requireInBounds(row, col);
    if (!this.players.has(playerId)) throw new Error(`unknown player: ${playerId}`);
    const player = this.players.get(playerId);
    if (!player) throw new Error(`player not found: ${playerId}`);
    const cardsRow = this.cards[row];
    const faceUpRow = this.faceUp[row];
    const controllerRow = this.controller[row];
    if (!cardsRow || !faceUpRow || !controllerRow) throw new Error('invalid row');
    if (player.getSecondCard() !== null) {
        await this.cleanupPreviousPlay(player); // does 3-A or 3-B as appropriate
    }
    // Check if this is a first card or second card flip
    const isFirstCard = player.isFirstCardFlip();
    if (isFirstCard) {
        // First card flip - clean up previous play FIRST (3-A/3-B)
        await this.cleanupPreviousPlay(player);
        const pic = cardsRow[col];
        // 1-A: No card there (empty space)
        if (pic === null) {
            throw new Error('empty space');
        }
        const isFaceUp = faceUpRow[col] ?? false;
        const ctrl = controllerRow[col];
        // 1-B: Card is face down - flip it up and take control
        if (!isFaceUp) {
            faceUpRow[col] = true;
            controllerRow[col] = playerId;
            player.setFirstCard({ row, col });
            player.recordFlip();
            console.log(`[BOARD] ${playerId} CONTROLS FIRST at (${row},${col}) via 1-B (flipped face up)`);
            this.checkRep();
            this.notifyChange();
            return;
        }
        // 1-C: Card is face up but not controlled - take control
        if (ctrl === null) {
            controllerRow[col] = playerId;
            player.setFirstCard({ row, col });
            player.recordFlip();
            console.log(`[BOARD] ${playerId} CONTROLS FIRST at (${row},${col}) via 1-C (already face up, unowned)`);
            this.checkRep();
            return;
        }
        // 1-D: Card is face up and controlled by another player - wait
        if (ctrl !== playerId) {
            console.log(`[BOARD] ${playerId} is WAITING to flip (${row},${col}) — currently controlled by ${ctrl}`);
            const key = `${row},${col}`;
            const deferred = new Deferred<void>();
            if (!this.waitingForControl.has(key)) {
                this.waitingForControl.set(key, []);
            }
            this.waitingForControl.get(key)?.push(deferred);
            await deferred.promise;
            console.log(`[BOARD] ${playerId} resumes after WAIT on (${row},${col})`);
            // After waiting, try again (recursive call)
            return this.flipUp(playerId, row, col);
        }
        // If we get here, ctrl === playerId (player is re-selecting their own card)
        player.setFirstCard({ row, col });
        player.recordFlip();
        this.checkRep();
        this.notifyChange();
    } else {
        // Second card flip
        const firstCard = player.getFirstCard();
        if (!firstCard) {
            throw new Error('internal error: no first card');
        }
        // Check if trying to flip the same card twice
        if (firstCard.row === row && firstCard.col === col) {
            const firstCtrlRow = this.controller[firstCard.row];
            if (firstCtrlRow && firstCtrlRow[firstCard.col] === playerId) {
                firstCtrlRow[firstCard.col] = null;
                console.log(`[BOARD] ${playerId} RELINQUISHES FIRST/SECOND at (${firstCard.row},${firstCard.col}) due to selecting same card twice (2-B)`);
                this.notifyWaiters(firstCard.row, firstCard.col);
            }
            this.rememberLingering(playerId, firstCard.row, firstCard.col);
            player.clearCards();
            throw new Error('cannot select the same card twice');
        }
        const pic = cardsRow[col];
        // 2-A: No card there (empty space)
        if (pic === null) {
            // Relinquish control of first card
            const firstCtrlRow = this.controller[firstCard.row];
            if (firstCtrlRow && firstCtrlRow[firstCard.col] === playerId) {
                firstCtrlRow[firstCard.col] = null;
                this.notifyWaiters(firstCard.row, firstCard.col);
            }
            console.log(`[BOARD] ${playerId} RELINQUISHES FIRST at (${firstCard.row},${firstCard.col}) due to 2-A (second was empty at (${row},${col}))`);
            this.rememberLingering(playerId, firstCard.row, firstCard.col);
            player.clearCards();
            throw new Error('empty space');
        }
        const isFaceUp = faceUpRow[col] ?? false;
        const ctrl = controllerRow[col];
        // 2-B: Card is face up and controlled - fail (avoid deadlock)
        if (isFaceUp && ctrl !== null) {
            // Relinquish control of first card
            const firstCtrlRow = this.controller[firstCard.row];
            if (firstCtrlRow && firstCtrlRow[firstCard.col] === playerId) {
                firstCtrlRow[firstCard.col] = null;
                this.notifyWaiters(firstCard.row, firstCard.col);
            }
            console.log(`[BOARD] ${playerId} RELINQUISHES FIRST at (${firstCard.row},${firstCard.col}) due to 2-B (second at (${row},${col}) controlled by ${ctrl})`);
            this.rememberLingering(playerId, firstCard.row, firstCard.col);
            player.clearCards();
            throw new Error('card is controlled by another player');
        }
        // 2-C: Flip card face up if it's face down
        if (!isFaceUp) {
            faceUpRow[col] = true;
            console.log(`[BOARD] ${playerId} FLIPS SECOND at (${row},${col}) via 2-C`);
        }
        // Take control of the second card
        controllerRow[col] = playerId;
        player.setSecondCard({ row, col });
        player.recordFlip();
        // Check for match
        const firstPic = this.pictureAt(firstCard.row, firstCard.col);
        const secondPic = pic;
        if (firstPic === secondPic && firstPic !== null) {
            // 2-D: Match! Keep control of both cards
            console.log(`[BOARD] ${playerId} MATCHES (${firstCard.row},${firstCard.col}) <-> (${row},${col}) via 2-D (keeps control until next first)`);
            // Cards stay controlled and face up until next first card flip (3-A)
        } else {
            // 2-E: No match - relinquish control of both cards
            const firstCtrlRow = this.controller[firstCard.row];
            if (firstCtrlRow && firstCtrlRow[firstCard.col] === playerId) {
                firstCtrlRow[firstCard.col] = null;
                this.notifyWaiters(firstCard.row, firstCard.col);
            }
            console.log(`[BOARD] ${playerId} NO MATCH via 2-E; relinquishes both (${firstCard.row},${firstCard.col}) & (${row},${col}) (stay face up until 3-B)`);
            controllerRow[col] = null;
            this.notifyWaiters(row, col);
            // Cards remain face up until next first card flip (3-B)
        }
        this.checkRep();
        this.notifyChange();
    }
}

    /**
     * Clean up a player's previous play before starting a new first card flip.
     * @param player the player whose previous play should be cleaned up
     * @returns promise that resolves when cleanup is complete
     */
    private async cleanupPreviousPlay(player: Player): Promise<void> {
    const firstCard = player.getFirstCard();
    const secondCard = player.getSecondCard();
    const pid = player.getId();
    const linger = this.lingering.get(pid);
    if (linger && linger.length) {
        for (const { row, col } of linger) {
        // Only flip down if the card is still on board, is face up, and uncontrolled (3-B)
        this.flipDownIfUncontrolled(row, col);
        }
        this.lingering.delete(pid);
    }
    
    if (firstCard && secondCard) {
        // Had two cards from previous play
        const firstPic = this.pictureAt(firstCard.row, firstCard.col);
        const secondPic = this.pictureAt(secondCard.row, secondCard.col);
        
        if (firstPic === secondPic && firstPic !== null) {
            // 3-A: Matching pair - remove from board
            const firstCardsRow = this.cards[firstCard.row];
            const secondCardsRow = this.cards[secondCard.row];
            const firstCtrlRow = this.controller[firstCard.row];
            const secondCtrlRow = this.controller[secondCard.row];
            const firstFaceUpRow = this.faceUp[firstCard.row];
            const secondFaceUpRow = this.faceUp[secondCard.row];
            
            if (firstCardsRow && firstCtrlRow && firstFaceUpRow) {
                // Only remove if player still controls the card
                if (firstCtrlRow[firstCard.col] === player.getId()) {
                    firstCardsRow[firstCard.col] = null;
                    firstFaceUpRow[firstCard.col] = false;
                    firstCtrlRow[firstCard.col] = null;
                    this.notifyWaiters(firstCard.row, firstCard.col);
                }
            }
            
            if (secondCardsRow && secondCtrlRow && secondFaceUpRow) {
                // Only remove if player still controls the card
                if (secondCtrlRow[secondCard.col] === player.getId()) {
                    secondCardsRow[secondCard.col] = null;
                    secondFaceUpRow[secondCard.col] = false;
                    secondCtrlRow[secondCard.col] = null;
                    this.notifyWaiters(secondCard.row, secondCard.col);
                }
            }
            console.log(`[BOARD] ${player.getId()} REMOVES MATCHED PAIR via 3-A at (${firstCard.row},${firstCard.col}) and (${secondCard.row},${secondCard.col})`);

        } else {
            // 3-B: Non-matching cards - flip down if conditions met
            this.flipDownIfUncontrolled(firstCard.row, firstCard.col);
            this.flipDownIfUncontrolled(secondCard.row, secondCard.col);
        }
    } else if (firstCard) {
        // Had only first card from previous play (no second card was flipped)
        // This happens if second card flip failed (2-A or 2-B)
        this.flipDownIfUncontrolled(firstCard.row, firstCard.col);
    }
    
    // Clear player's card state
    player.clearCards();
}
    /**
     * Flip down a card if it's face up, not controlled, and still on the board.
     * This implements the condition in rule 3-B for cleaning up non-matching cards.
     * 
     * @param row row index of the card (0-based)
     * @param col column index of the card (0-based)
     */
    private flipDownIfUncontrolled(row: number, col: number): void {
        const cardsRow = this.cards[row];
        const faceUpRow = this.faceUp[row];
        const controllerRow = this.controller[row];
        
        if (!cardsRow || !faceUpRow || !controllerRow) return;
        
        const pic = cardsRow[col];
        const isFaceUp = faceUpRow[col] ?? false;
        const ctrl = controllerRow[col];
        
        // Only flip down if: card is still on board, face up, and not controlled
        if (pic !== null && isFaceUp && ctrl === null) {
            faceUpRow[col] = false;
            
        }
    }


    /**
     * Notify waiting players that a card is now available for control.
     * Resolves all deferred promises for players waiting on the specified card.
     * Called when a player relinquishes control or when a card is removed.
     * 
     * @param row row index of the card (0-based)
     * @param col column index of the card (0-based)
     */
    private notifyWaiters(row: number, col: number): void {
        const key = `${row},${col}`;
        const waiters = this.waitingForControl.get(key);
        
        if (waiters && waiters.length > 0) {
            while (waiters.length > 0) {
                const waiter = waiters.shift();
                if (waiter) {
                    waiter.resolve();
                }
            }
        }
        this.waitingForControl.delete(key);
    }


    /**
     * Flip a card face-down and remove its controller (synchronous version for backwards compatibility).
     * 
     * @param row row index of the card (0-based)
     * @param col column index of the card (0-based)
     * @throws Error if:
     *         - row or col are out of bounds
     *         - the cell is empty
     *         - the card is already face-down
     */
    public flipDown(row: number, col: number): void {
        this.requireInBounds(row, col);
        
        const cardsRow = this.cards[row];
        const faceUpRow = this.faceUp[row];
        const controllerRow = this.controller[row];
        
        if (!cardsRow || !faceUpRow || !controllerRow) throw new Error('invalid row');
        
        const pic = cardsRow[col];
        if (pic === null) throw new Error('empty space');
        const isFaceUp = faceUpRow[col] ?? false;
        if (!isFaceUp) throw new Error('already face down');

        faceUpRow[col] = false;
        controllerRow[col] = null;

        this.checkRep();
        this.notifyChange();
    }

  // ==============================
  // Construction from a file (P1)
  // ==============================

    /**
     * Parse a board from a file.
     * 
     * File format:
     *   - First line: "rows×cols" (e.g., "3x4")
     *   - Next rows×cols lines: one card picture per line
     * 
     * @param filename path to the board file
     * @returns a new Board parsed from the file
     * @throws Error if:
     *         - file cannot be read
     *         - no header line
     *         - header is malformed
     *         - dimensions are invalid (not positive integers)
     *         - wrong number of cards
     *         - any card token contains whitespace or is empty
     */
    public static async parseFromFile(filename: string): Promise<Board> {
    try {
        const text = (await fs.promises.readFile(filename)).toString();
        const norm = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        let lines = norm.split('\n');
        
        // Remove trailing empty line if any
        if (lines.length > 0 && lines[lines.length - 1] === '') {
            lines = lines.slice(0, -1);
        }
        if (lines.length === 0) throw new Error('empty file');

        // Header: ^(\d+)x(\d+)$
        const headerLine = lines[0];
        if (headerLine === undefined) throw new Error('missing header');
        const header = headerLine.trim();
        if (header.length === 0) throw new Error('missing header');
        const m = header.match(/^(\d+)x(\d+)$/);
        if (!m) throw new Error(`invalid header: ${header}`);
        const rows = Number(m[1]);
        const cols = Number(m[2]);
        if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1) {
            throw new Error(`invalid dimensions: ${rows}x${cols}`);
        }

        const expected = rows * cols;
        const cardLines = lines.slice(1);
        if (cardLines.length !== expected) {
            throw new Error(`expected ${expected} cards, found ${cardLines.length}`);
        }

        const layout: (string | null)[] = [];
        for (let i = 0; i < cardLines.length; i++) {
            const tok = cardLines[i];
            if (tok === undefined || tok.length === 0 || !/^[^\s]+$/.test(tok)) {
                throw new Error(`invalid card at line ${i + 2}: ${tok}`);
            }
            layout.push(tok);
        }

        return new Board(rows, cols, layout);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`parseFromFile failed for ${filename}: ${msg}`);
    }
}

  // ==============
  // Helpers
  // ==============

    /**
     * Check that row and col are valid indices for this board.
     * 
     * @param row row index to check
     * @param col column index to check
     * @throws Error if row or col are not integers, or are out of bounds
     */
    private requireInBounds(row: number, col: number): void {
        if (!Number.isInteger(row) || !Number.isInteger(col)) throw new Error('indices must be integers');
        if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) throw new Error('out of bounds');
    }
    }
