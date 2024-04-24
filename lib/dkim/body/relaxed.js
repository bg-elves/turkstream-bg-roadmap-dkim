/* eslint no-control-regex: 0 */

'use strict';

const { Buffer } = require('node:buffer');
const crypto = require('node:crypto');
const { MimeStructureStartFinder } = require('../mime-structure-start-finder');

const CHAR_CR = 0x0d;
const CHAR_LF = 0x0a;
const CHAR_SPACE = 0x20;
const CHAR_TAB = 0x09;

/**
 * Class for calculating body hash of an email message body stream
 * using the "relaxed" canonicalization
 *
 * @class
 */
class RelaxedHash {
    /**
     * @param {String} [algorithm] Hashing algo, either "sha1" or "sha256"
     * @param {Number} [maxBodyLength] Allowed body length count, the value from the l= parameter
     */
    constructor(algorithm, maxBodyLength) {
        algorithm = (algorithm || 'sha256').split('-').pop().toLowerCase();

        this.bodyHash = crypto.createHash(algorithm);

        this.remainder = false;

        // total body size
        this.byteLength = 0;
        // total canonicalized body size
        this.canonicalizedLength = 0;
        // hashed canonicalized body size (after l= tag)
        this.bodyHashedBytes = 0;

        this.maxBodyLength = maxBodyLength;

        this.maxSizeReached = maxBodyLength === 0;

        this.emptyLinesQueue = [];

        this.mimeStructureStartFinder = new MimeStructureStartFinder();
    }

    setContentType(contentTypeObj) {
        if (/^multipart\//i.test(contentTypeObj.value) && contentTypeObj.params.boundary) {
            this.mimeStructureStartFinder.setBoundary(contentTypeObj.params.boundary);
        }
    }

    _updateBodyHash(chunk) {
        // serach through the entire document, not just signed part
        this.mimeStructureStartFinder.update(chunk);

        this.canonicalizedLength += chunk.length;

        if (this.maxSizeReached) {
            return;
        }

        // the following is needed for the l= option
        if (
            typeof this.maxBodyLength === 'number' &&
            !isNaN(this.maxBodyLength) &&
            this.maxBodyLength >= 0 &&
            this.bodyHashedBytes + chunk.length > this.maxBodyLength
        ) {
            this.maxSizeReached = true;
            if (this.bodyHashedBytes >= this.maxBodyLength) {
                // nothing to do here, skip entire chunk
                return;
            }

            // only use allowed size of bytes
            chunk = chunk.subarray(0, this.maxBodyLength - this.bodyHashedBytes);
        }

        this.bodyHashedBytes += chunk.length;
        this.bodyHash.update(chunk);

        //process.stdout.write(chunk);
    }

    _drainPendingEmptyLines() {
        if (this.emptyLinesQueue.length) {
            for (let emptyLine of this.emptyLinesQueue) {
                this._updateBodyHash(emptyLine);
            }
            this.emptyLinesQueue = [];
        }
    }

    _pushBodyHash(chunk) {
        if (!chunk || !chunk.length) {
            return;
        }

        // remove line endings
        let foundNonLn = false;

        // buffer line endings and empty lines
        for (let i = chunk.length - 1; i >= 0; i--) {
            if (chunk[i] !== CHAR_LF && chunk[i] !== CHAR_CR) {
                this._drainPendingEmptyLines();
                if (i < chunk.length - 1) {
                    this.emptyLinesQueue.push(chunk.subarray(i + 1));
                    chunk = chunk.subarray(0, i + 1);
                }
                foundNonLn = true;
                break;
            }
        }

        if (!foundNonLn) {
            this.emptyLinesQueue.push(chunk);
            return;
        }

        this._updateBodyHash(chunk);
    }

    fixLineBuffer(line) {
        let resultLine = [];

        let nonWspFound = false;
        let prevWsp = false;

        for (let i = line.length - 1; i >= 0; i--) {
            if (line[i] === CHAR_LF) {
                resultLine.unshift(line[i]);
                if (i === 0 || line[i - 1] !== CHAR_CR) {
                    // add missing carriage return
                    resultLine.unshift(CHAR_CR);
                }
                continue;
            }

            if (line[i] === CHAR_CR) {
                resultLine.unshift(line[i]);
                continue;
            }

            if (line[i] === CHAR_SPACE || line[i] === CHAR_TAB) {
                if (nonWspFound) {
                    prevWsp = true;
                }
                continue;
            }

            if (prevWsp) {
                resultLine.unshift(CHAR_SPACE);
                prevWsp = false;
            }

            nonWspFound = true;
            resultLine.unshift(line[i]);
        }

        if (prevWsp && nonWspFound) {
            resultLine.unshift(CHAR_SPACE);
        }

        return Buffer.from(resultLine);
    }

    update(chunk, final) {
        this.byteLength += (chunk && chunk.length) || 0;
        if (this.maxSizeReached) {
            return;
        }

        // Canonicalize content by applying a and b in order:
        // a.1. Ignore all whitespace at the end of lines.
        // a.2. Reduce all sequences of WSP within a line to a single SP character.

        // b.1. Ignore all empty lines at the end of the message body.
        // b.2. If the body is non-empty but does not end with a CRLF, a CRLF is added.

        let lineEndPos = -1;
        let lineNeedsFixing = false;
        let cursorPos = 0;

        if (this.remainder && this.remainder.length) {
            if (chunk) {
                // concatting chunks might be bad for performance :S
                chunk = Buffer.concat([this.remainder, chunk]);
            } else {
                chunk = this.remainder;
            }
            this.remainder = false;
        }

        if (chunk && chunk.length) {
            for (let pos = 0; pos < chunk.length; pos++) {
                switch (chunk[pos]) {
                    case CHAR_LF:
                        if (
                            !lineNeedsFixing &&
                            // previous character is not <CR>
                            ((pos >= 1 && chunk[pos - 1] !== CHAR_CR) ||
                                // LF is the first byte on the line
                                pos === 0 ||
                                // there's a space before line break
                                (pos >= 2 && chunk[pos - 1] === CHAR_CR && chunk[pos - 2] === CHAR_SPACE))
                        ) {
                            lineNeedsFixing = true;
                        }

                        // line break
                        if (lineNeedsFixing) {
                            // emit pending bytes up to the last line break before current line
                            if (lineEndPos >= 0 && lineEndPos >= cursorPos) {
                                let chunkPart = chunk.subarray(cursorPos, lineEndPos + 1);
                                this._pushBodyHash(chunkPart);
                            }

                            let line = chunk.subarray(lineEndPos + 1, pos + 1);
                            this._pushBodyHash(this.fixLineBuffer(line));

                            lineNeedsFixing = false;

                            // move cursor to the start of next line
                            cursorPos = pos + 1;
                        }

                        lineEndPos = pos;

                        break;

                    case CHAR_SPACE:
                        if (!lineNeedsFixing && pos && chunk[pos - 1] === CHAR_SPACE) {
                            lineNeedsFixing = true;
                        }
                        break;

                    case CHAR_TAB:
                        // non-space WSP always needs replacing
                        lineNeedsFixing = true;
                        break;

                    default:
                }
            }
        }

        if (chunk && cursorPos < chunk.length && cursorPos !== lineEndPos) {
            // emit data from chunk

            let chunkPart = chunk.subarray(cursorPos, lineEndPos + 1);

            if (chunkPart.length) {
                this._pushBodyHash(lineNeedsFixing ? this.fixLineBuffer(chunkPart) : chunkPart);
                lineNeedsFixing = false;
            }

            cursorPos = lineEndPos + 1;
        }

        if (chunk && !final && cursorPos < chunk.length) {
            this.remainder = chunk.subarray(cursorPos);
        }

        if (final) {
            let chunkPart = (cursorPos && chunk && chunk.subarray(cursorPos)) || chunk;
            if (chunkPart && chunkPart.length) {
                this._pushBodyHash(lineNeedsFixing ? this.fixLineBuffer(chunkPart) : chunkPart);
                lineNeedsFixing = false;
            }

            if (this.bodyHashedBytes) {
                // terminating line break for non-empty messages
                this._updateBodyHash(Buffer.from([CHAR_CR, CHAR_LF]));
            }
        }
    }

    digest(encoding) {
        this.update(null, true);

        // finalize
        return this.bodyHash.digest(encoding);
    }

    getMimeStructureStart() {
        return this.mimeStructureStartFinder.getMimeStructureStart();
    }
}

module.exports = { RelaxedHash };
