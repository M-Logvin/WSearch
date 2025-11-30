// app_logic.js (Start of file)

import createModule from './wordle_solver.js';
import { 
    ALL_GUESSES_FLAT, 
    N_TOTAL_GUESSES, 
    IS_POSSIBLE_ANSWER_MASK, 
    INITIAL_CANDIDATE_START_POSITIONS,
    LETTERS
} from './wordle_solver_data.js';
let Module; // Global WASM Module reference

// --- Core Initialization Logic ---
const runInitialization = () => {
    // We are now guaranteed that Module is defined and HEAP32 is attached.
    
    initializeWasmMemory(); 
    updateGuessDisplay(); 
    calculateBestGuess(); 
    updateStatusDisplay();
    // Attach event listeners to buttons
    document.getElementById('submit-feedback')?.addEventListener('click', handleSubmitFeedback);
    document.getElementById('reset-app')?.addEventListener('click', handleResetApp);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault(); // Prevents default browser behavior (e.g., form submission)
            handleSubmitFeedback(event);
        }
    });
    console.log("WASM Memory initialized. App is running.");
};

// --- WASM Module Loading ---
createModule({
    // THE FIX: This object is now empty. The glue code will not call any hooks.
}).then(wasmModule => {
    // 1. Assign the WASM instance to the global Module variable.
    Module = wasmModule; 
    
    // 2. NOW, run the initialization logic.
    runInitialization(); 
}).catch(error => {
    console.error("WASM Module Load Failed:", error);
    // Handle error display
});

// ... (Rest of your app_logic.js file: STATE, functions, etc.)

// State Variables (replicate Shiny's rv)
const STATE = {
    // Array of integers (start positions in ALL_GUESSES_FLAT)
    currentCandidates: [], 
    currentGuessWord: "SOARE", 
    feedbackState: ["_", "_", "_", "_", "_"], // _, Y, G
    history: [],
    gameOver: false,
    isCalculating: false,
};

// Colors mapping used by the solver
const COLOR_MAP = {
    "_": 0, // Gray
    "Y": 1, // Yellow
    "G": 2  // Green
};

// --- WASM Memory Pointers (Allocated Once) ---
let WASM_PTR = {
    // Large static buffers for the entire word list
    guessesFlat: 0,         // ALL_GUESSES_FLAT copy (read-only)
    isPossibleAnswer: 0,    // IS_POSSIBLE_ANSWER_MASK copy (read-only)

    // Dynamic buffers that change size/content
    currentCandidatesA: 0,  // Candidate indices buffer 1
    currentCandidatesB: 0,  // Candidate indices buffer 2 (for filtering swap)
    
    // Result buffers
    scores: 0,              // Scores (double array)
    guessWordVec: 0,        // 5-integer array for the current guess (used by filter)
};


// --- Helper Functions ---

/** Converts a 5-integer array (1-26) back to a 5-character string. */
function intVecToString(intArray) {
    let word = "";
    for (const charInt of intArray) {
        word += LETTERS[charInt];
    }
    return word;
}

/** Converts a 5-character string to a 5-integer array (1-26). */
function stringToIntVec(word) {
    const ints = [];
    const baseCharCode = 'A'.charCodeAt(0);
    for (let i = 0; i < 5; i++) {
        ints.push(word.charCodeAt(i) - baseCharCode + 1);
    }
    return ints;
}

/** Encodes the color pattern array ["_", "Y", "G"] into a base-3 integer (0-242). */
function encodePattern(fbArray) {
    let pattern = 0;
    const weights = [1, 3, 9, 27, 81];
    for (let i = 0; i < 5; i++) {
        pattern += COLOR_MAP[fbArray[i]] * weights[i];
    }
    return pattern;
}

/** Cycles the feedback state for a tile: Gray -> Yellow -> Green -> Gray */
function nextColor(current) {
    const cycle = ["_", "Y", "G"];
    let idx = cycle.indexOf(current);
    return cycle[(idx + 1) % cycle.length];
}

// --- WASM Interaction and Calculation ---

/**
 * Replicates the calculate_best_guess logic, calling WASM for scores.
 * @returns {object} {guessString: string, guessPosition: number}
 */
async function calculateBestGuess() {
    if (STATE.currentCandidates.length === 1) {
        // Find the word in the flat array and convert to string
        const startPos = STATE.currentCandidates[0];
        const wordInts = new Int32Array(Module.HEAP32.buffer, WASM_PTR.guessesFlat + startPos * 4, 5);
        
        // This is safe because only one word remains
        STATE.currentGuessWord = intVecToString(wordInts); 
        return;
    }

    const nCand = STATE.currentCandidates.length;
    const useMinimax = nCand < 31;
    const isMinimax = useMinimax ? 1 : 0;
    
    // Set loading state
    STATE.isCalculating = true;
    updateStatusDisplay();

    // The core calculation happens here
    // 1. Calculate Primary Scores (Entropy or Minimax)
    
    // Call C++: cpp_calculate_scores_wasm(guesses_ptr, n_guesses, candidates_ptr, n_cands, scores_ptr, is_minimax)
    Module._cpp_calculate_scores_wasm(
        WASM_PTR.guessesFlat, N_TOTAL_GUESSES,
        WASM_PTR.currentCandidatesA, nCand, // Current candidates list
        WASM_PTR.scores, isMinimax
    );

    // Read scores from the WASM heap
    const scoresArray = new Float64Array(Module.HEAPF64.buffer, WASM_PTR.scores, N_TOTAL_GUESSES);

    // 2. Determine Best Score(s) and Indices
    let bestScore = useMinimax ? Infinity : -Infinity;
    let bestIndices = [];

    for (let i = 0; i < N_TOTAL_GUESSES; i++) {
        const score = scoresArray[i];
        if (useMinimax) {
            if (score < bestScore) {
                bestScore = score;
                bestIndices = [i];
            } else if (score === bestScore) {
                bestIndices.push(i);
            }
        } else {
            if (score > bestScore) {
                bestScore = score;
                bestIndices = [i];
            } else if (score === bestScore) {
                bestIndices.push(i);
            }
        }
    }
    
    // 3. Tie-Breaking Logic (replicates R logic in JS)
    
    // A. Tie-breaker with Entropy (if Minimax was used and there are ties)
    if (bestIndices.length > 1 && useMinimax) {
        
        // Recalculate scores using Entropy (isMinimax = 0)
        Module._cpp_calculate_scores_wasm(
            WASM_PTR.guessesFlat, N_TOTAL_GUESSES,
            WASM_PTR.currentCandidatesA, nCand,
            WASM_PTR.scores, 0 // Use Entropy score (0 = false)
        );
        
        const entropyScores = new Float64Array(Module.HEAPF64.buffer, WASM_PTR.scores, N_TOTAL_GUESSES);
        
        let subsetScores = bestIndices.map(i => entropyScores[i]);
        let maxEntropy = Math.max(...subsetScores);
        
        // Filter bestIndices to keep only those with max entropy
        bestIndices = bestIndices.filter((_, idx) => subsetScores[idx] === maxEntropy);
    }

    // B. Tie-breaker: Prefer actual answers (IS_POSSIBLE_ANSWER_MASK)
    if (bestIndices.length > 1) {
        // Read mask from WASM heap
        const possibleAnswerMask = new Int32Array(Module.HEAP32.buffer, WASM_PTR.isPossibleAnswer, N_TOTAL_GUESSES);
        
        const answerIndices = bestIndices.filter(i => possibleAnswerMask[i] === 1);
        
        if (answerIndices.length > 0) {
            bestIndices = answerIndices;
        }
    }

    // 4. Final Guess Selection
    const finalGuessIndex = bestIndices[0];
    
    // Read the chosen word's integer vector from the WASM heap
    const wordStartPos = finalGuessIndex * 5;
    const wordInts = new Int32Array(Module.HEAP32.buffer, WASM_PTR.guessesFlat + wordStartPos * 4, 5);

    STATE.currentGuessWord = intVecToString(wordInts);
    STATE.isCalculating = false;
}

// --- UI Rendering Functions ---

function updateStatusDisplay() {
    const statusDiv = document.getElementById('status-text');
    const n = STATE.currentCandidates.length;
    let text = `Candidates remaining: ${n}`;
    
    if (STATE.isCalculating) {
        text = "Candidates remaining: Thinking...";
    }
    
    statusDiv.textContent = text;
}

function updateHistoryDisplay() {
    const historyDiv = document.getElementById('history-display');
    historyDiv.innerHTML = '';
    
    for (const entry of STATE.history) {
        const historyRow = document.createElement('div');
        historyRow.style.marginBottom = '5px';
        for (let i = 0; i < 5; i++) {
            const letter = entry.word[i];
            const color = entry.fb[i];
            const tile = document.createElement('span');
            tile.style.cssText = `display:inline-block;width:30px;height:30px;background-color:${COLOR_MAP[color] === 2 ? '#6aaa64' : COLOR_MAP[color] === 1 ? '#c9b458' : '#787c7e'};color:white;text-align:center;line-height:30px;margin:1px;font-weight:bold;`;
            tile.textContent = letter;
            historyRow.appendChild(tile);
        }
        historyDiv.appendChild(historyRow);
    }
}

// --- Event Handlers ---

function handleTileClick(event) {
    if (STATE.gameOver) return;
    const index = parseInt(event.target.dataset.index);
    const currentColor = STATE.feedbackState[index];
    const newColor = nextColor(currentColor);
    
    // Update state and UI
    STATE.feedbackState[index] = newColor;
    event.target.className = `guess-tile ${newColor === '_' ? 'gray' : newColor === 'Y' ? 'yellow' : 'green'}`;
}

// app_logic.js (Updated sections for handleSubmitFeedback and handleResetApp)

async function handleSubmitFeedback(event) {
    // Check if event is passed (from keyboard) and if it's the Enter key
    if (event && event.key && event.key !== 'Enter') return; 

    // Ensure WASM Module is fully ready (safety check, though initialized in runInitialization)
    if (!Module || !Module.HEAP32) {
        console.warn("WASM not fully initialized. Blocking submit attempt.");
        return; 
    }

    if (STATE.gameOver || STATE.isCalculating) return;

    // 1. Record History
    STATE.history.push({ 
        word: STATE.currentGuessWord, 
        fb: [...STATE.feedbackState] // Copy the array
    });

    // 2. Check Win (User marked all Green)
    if (STATE.feedbackState.every(c => c === 'G')) {
        STATE.gameOver = true;
        updateGuessDisplay();
        updateHistoryDisplay();
        updateStatusDisplay('Solved!'); 
        return;
    }

    // 3. Filter Candidates
    const patternInt = encodePattern(STATE.feedbackState);
    const oldCandCount = STATE.currentCandidates.length;

    // Allocate memory for the current guess word in 5-int form
    const guessIntVec = stringToIntVec(STATE.currentGuessWord);
    Module.HEAP32.set(guessIntVec, WASM_PTR.guessWordVec / 4); // /4 because HEAP32 works with 4-byte offsets

    // Call C++: cpp_filter_candidates_wasm(guess_ptr, pattern, all_guesses_ptr, old_cands_ptr, n_old, new_cands_ptr)
    const remainingCount = Module._cpp_filter_candidates_wasm(
        WASM_PTR.guessWordVec, patternInt,
        WASM_PTR.guessesFlat,
        WASM_PTR.currentCandidatesA, oldCandCount,
        WASM_PTR.currentCandidatesB // Write results into buffer B
    );

    // 4. Update Candidate State and Handle Game End Conditions

    if (remainingCount === 0) {
        // 🛑 ERROR STATE (0 words left)
        STATE.gameOver = true;
        STATE.currentGuessWord = "ERROR"; // Identifier for the display logic
        STATE.feedbackState = ["E", "R", "R", "O", "R"]; // Custom color key for Red (We will map 'E', 'R', 'O' to red in updateGuessDisplay)
        updateStatusDisplay('Error: No words match this pattern.');

    } else if (remainingCount === 1) {
        // ✅ SUCCESS STATE (1 word left)
        STATE.gameOver = true;
        
        // Read the final word to update STATE.currentGuessWord
        const finalWordIndex = new Int32Array(Module.HEAP32.buffer, WASM_PTR.currentCandidatesB, 1)[0];
        const wordStartPos = finalWordIndex * 5;
        const wordInts = new Int32Array(Module.HEAP32.buffer, WASM_PTR.guessesFlat + wordStartPos * 4, 5);
        STATE.currentGuessWord = intVecToString(wordInts);
        
        // Set feedback state to Green for the visual effect
        STATE.feedbackState = ["G", "G", "G", "G", "G"]; 
        updateStatusDisplay(`Solved! The word is: ${STATE.currentGuessWord}`);

    } else {
        // 🔄 CONTINUE STATE (2+ words left)
        // Read the new indices from Buffer B
        const newCandidatesIndices = new Int32Array(Module.HEAP32.buffer, WASM_PTR.currentCandidatesB, remainingCount);
        STATE.currentCandidates = Array.from(newCandidatesIndices);
        
        // Swap buffers A and B for the next filter/score call
        [WASM_PTR.currentCandidatesA, WASM_PTR.currentCandidatesB] = [WASM_PTR.currentCandidatesB, WASM_PTR.currentCandidatesA];

        // 5. Calculate Next Guess
        await calculateBestGuess();
        
        // Reset UI State (Only if continuing)
        STATE.feedbackState = ["_", "_", "_", "_", "_"];
    }

    // 6. Update Displays (Runs regardless of game over state)
    updateGuessDisplay();
    updateHistoryDisplay();
    // If a custom message was set above, updateStatusDisplay() without arguments will use it.
    if (!STATE.gameOver) {
        updateStatusDisplay();
    }
}

function handleResetApp() {
    // Reset state to initial conditions
    STATE.currentCandidates = [...INITIAL_CANDIDATE_START_POSITIONS];
    STATE.currentGuessWord = "SOARE"; 
    STATE.feedbackState = ["_", "_", "_", "_", "_"];
    STATE.history = [];
    STATE.gameOver = false;

    // Copy initial candidates into WASM heap A
    Module.HEAP32.set(STATE.currentCandidates, WASM_PTR.currentCandidatesA / 4);

    updateGuessDisplay();
    updateHistoryDisplay();
    updateStatusDisplay();
}

// ...

function updateGuessDisplay() {
    const displayDiv = document.getElementById('guess-display');
    displayDiv.innerHTML = '';
    
    // REMOVE the previous logic that replaced tiles with "Game Over!" text.

    for (let i = 0; i < 5; i++) {
        let letter = STATE.currentGuessWord[i];
        let colorKey = STATE.feedbackState[i];
        let cssClass;

        // Determine the CSS class based on the state
        if (STATE.gameOver && STATE.currentGuessWord === "ERROR") {
            // Force Red color and use the word "ERROR" as the text
            cssClass = 'red'; 
            letter = "ERROR"[i]; 
        } else {
            // Use existing logic for ongoing game, solved game, or final guess
            cssClass = colorKey === '_' ? 'gray' : colorKey === 'Y' ? 'yellow' : 'green';
        }
        
        const tile = document.createElement('div');
        tile.className = `guess-tile ${cssClass}`;
        tile.textContent = letter;
        
        // Only attach click listeners if the game is NOT over or if it's the ERROR state (to allow reset)
        if (!STATE.gameOver) {
            tile.dataset.index = i; // Store index for event listener
            tile.addEventListener('click', handleTileClick);
        }
        
        displayDiv.appendChild(tile);
    }
}

// --- Initialization ---

/** Allocates and initializes all necessary WASM memory buffers. */
function initializeWasmMemory() {
    const intSize = 4; // Int32
    const doubleSize = 8; // Float64
    const nTotal = N_TOTAL_GUESSES;
    const nCandsStart = INITIAL_CANDIDATE_START_POSITIONS.length;

    // 1. Static Data (Read-only copies)
    WASM_PTR.guessesFlat = Module._malloc(ALL_GUESSES_FLAT.length * intSize);
    Module.HEAP32.set(ALL_GUESSES_FLAT, WASM_PTR.guessesFlat / intSize);

    WASM_PTR.isPossibleAnswer = Module._malloc(IS_POSSIBLE_ANSWER_MASK.length * intSize);
    Module.HEAP32.set(IS_POSSIBLE_ANSWER_MASK, WASM_PTR.isPossibleAnswer / intSize);

    // 2. Dynamic Buffers (Candidate Index Lists)
    // Allocate space for the max possible number of candidates (nTotal) for safety/reuse
    WASM_PTR.currentCandidatesA = Module._malloc(nTotal * intSize);
    WASM_PTR.currentCandidatesB = Module._malloc(nTotal * intSize);

    // Initialize buffer A with starting candidates
    Module.HEAP32.set(INITIAL_CANDIDATE_START_POSITIONS, WASM_PTR.currentCandidatesA / intSize);
    STATE.currentCandidates = [...INITIAL_CANDIDATE_START_POSITIONS]; // Initialize JS state

    // 3. Calculation Buffers
    WASM_PTR.scores = Module._malloc(nTotal * doubleSize);
    WASM_PTR.guessWordVec = Module._malloc(5 * intSize); // Temp buffer for the 5-int guess vector
}
