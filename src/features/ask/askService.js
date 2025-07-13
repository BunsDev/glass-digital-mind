const { BrowserWindow } = require('electron');
const { createStreamingLLM } = require('../common/ai/factory');
const { getCurrentModelInfo, windowPool, captureScreenshot } = require('../../window/windowManager');
const sessionRepository = require('../common/repositories/session');
const askRepository = require('./repositories');
const { getSystemPrompt } = require('../common/prompts/promptBuilder');
const listenService = require('../listen/listenService');

/**
 * @class
 * @description
 */
class AskService {
    constructor() {
        this.abortController = null;
        this.state = {
            isVisible: false,
            isLoading: false,
            isStreaming: false,
            currentQuestion: '',
            currentResponse: '',
            showTextInput: true,
        };
        console.log('[AskService] Service instance created.');
    }

    _broadcastState() {
        const askWindow = windowPool.get('ask');
        if (askWindow && !askWindow.isDestroyed()) {
            askWindow.webContents.send('ask:stateUpdate', this.state);
        }
    }

    async toggleAskButton() {
        const { windowPool, updateLayout } = require('../../window/windowManager');
        const askWindow = windowPool.get('ask');

        const hasContent = this.state.isStreaming || (this.state.currentResponse && this.state.currentResponse.length > 0);

        if (askWindow.isVisible() && hasContent) {
            this.state.showTextInput = !this.state.showTextInput;
            this._broadcastState();
        } else {
            if (askWindow.isVisible()) {
                askWindow.webContents.send('window-hide-animation');
                this.state.isVisible = false;
            } else {
                console.log('[AskService] Showing hidden Ask window');
                this.state.isVisible = true;
                askWindow.show();
                updateLayout();
                askWindow.webContents.send('window-show-animation');
            }
            if (this.state.isVisible) {
                this.state.showTextInput = true;
                this._broadcastState();
            }
        }
    }
    

    /**
     * 
     * @param {string[]} conversationTexts
     * @returns {string}
     * @private
     */
    _formatConversationForPrompt(conversationTexts) {
        if (!conversationTexts || conversationTexts.length === 0) {
            return 'No conversation history available.';
        }
        return conversationTexts.slice(-30).join('\n');
    }

    /**
     * 
     * @param {string} userPrompt
     * @returns {Promise<{success: boolean, response?: string, error?: string}>}
     */
    async sendMessage(userPrompt) {
        if (this.abortController) {
            this.abortController.abort('New request received.');
        }
        this.abortController = new AbortController();
        const { signal } = this.abortController;

        if (!userPrompt || userPrompt.trim().length === 0) {
            console.warn('[AskService] Cannot process empty message');
            return { success: false, error: 'Empty message' };
        }

        let sessionId;

        try {
            console.log(`[AskService] 🤖 Processing message: ${userPrompt.substring(0, 50)}...`);
            
            this.state = {
                ...this.state,
                isLoading: true,
                isStreaming: false,
                currentQuestion: userPrompt,
                currentResponse: '',
                showTextInput: false,
            };
            this._broadcastState();

            sessionId = await sessionRepository.getOrCreateActive('ask');
            await askRepository.addAiMessage({ sessionId, role: 'user', content: userPrompt.trim() });
            console.log(`[AskService] DB: Saved user prompt to session ${sessionId}`);
            
            const modelInfo = await getCurrentModelInfo(null, { type: 'llm' });
            if (!modelInfo || !modelInfo.apiKey) {
                throw new Error('AI model or API key not configured.');
            }
            console.log(`[AskService] Using model: ${modelInfo.model} for provider: ${modelInfo.provider}`);

            const screenshotResult = await captureScreenshot({ quality: 'medium' });
            const screenshotBase64 = screenshotResult.success ? screenshotResult.base64 : null;

            let conversationHistoryRaw = [];
            try {
                const history = listenService.getConversationHistory();
                if (history && Array.isArray(history) && history.length > 0) {
                    console.log(`[AskService] Using conversation history from ListenService ${history.length} items).`);
                    conversationHistoryRaw = history;
                } else {
                    console.log('[AskService] No active conversation history found in ListenService.');
                }
            } catch (error) {
                console.error('[AskService] Failed to get conversation history from ListenService:', error);
            }
            const conversationHistory = this._formatConversationForPrompt(conversationHistoryRaw);
            console.log(`[AskService] Using conversation history (${conversationHistory}`);

            const systemPrompt = getSystemPrompt('pickle_glass_analysis', conversationHistory, false);

            const messages = [
                { role: 'system', content: systemPrompt },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: `User Request: ${userPrompt.trim()}` },
                    ],
                },
            ];

            if (screenshotBase64) {
                messages[1].content.push({
                    type: 'image_url',
                    image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` },
                });
            }
            
            const streamingLLM = createStreamingLLM(modelInfo.provider, {
                apiKey: modelInfo.apiKey,
                model: modelInfo.model,
                temperature: 0.7,
                maxTokens: 2048,
                usePortkey: modelInfo.provider === 'openai-glass',
                portkeyVirtualKey: modelInfo.provider === 'openai-glass' ? modelInfo.apiKey : undefined,
            });

            const response = await streamingLLM.streamChat(messages);
            const askWin = windowPool.get('ask');

            if (!askWin || askWin.isDestroyed()) {
                console.error("[AskService] Ask window is not available to send stream to.");
                response.body.getReader().cancel();
                return { success: false, error: 'Ask window is not available.' };
            }

            const reader = response.body.getReader();
            signal.addEventListener('abort', () => {
                console.log(`[AskService] Aborting stream reader. Reason: ${signal.reason}`);
                reader.cancel(signal.reason).catch(() => { /* 이미 취소된 경우의 오류는 무시 */ });
            });

            await this._processStream(reader, askWin, sessionId, signal);

            return { success: true };

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('[AskService] SendMessage operation was successfully aborted.');
                return { success: true, response: 'Cancelled' };
            }

            console.error('[AskService] Error processing message:', error);
            this.state.isLoading = false;
            this.state.error = error.message;
            this._broadcastState();
            return { success: false, error: error.message };
        }
    }

    /**
     * 
     * @param {ReadableStreamDefaultReader} reader
     * @param {BrowserWindow} askWin
     * @param {number} sessionId 
     * @param {AbortSignal} signal
     * @returns {Promise<void>}
     * @private
     */
    async _processStream(reader, askWin, sessionId, signal) {
        const decoder = new TextDecoder();
        let fullResponse = '';

        try {
            this.state.isLoading = false;
            this.state.isStreaming = true;
            this._broadcastState();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n').filter(line => line.trim() !== '');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.substring(6);
                        if (data === '[DONE]') {
                            return; 
                        }
                        try {
                            const json = JSON.parse(data);
                            const token = json.choices[0]?.delta?.content || '';
                            if (token) {
                                fullResponse += token;
                                this.state.currentResponse = fullResponse;
                                this._broadcastState();
                            }
                        } catch (error) {
                        }
                    }
                }
            }
        } catch (streamError) {
            if (signal.aborted) {
                console.log(`[AskService] Stream reading was intentionally cancelled. Reason: ${signal.reason}`);
            } else {
                console.error('[AskService] Error while processing stream:', streamError);
            }
        } finally {
            this.state.isStreaming = false;
            this.state.currentResponse = fullResponse;
            this._broadcastState();
            if (fullResponse) {
                 try {
                    await askRepository.addAiMessage({ sessionId, role: 'assistant', content: fullResponse });
                    console.log(`[AskService] DB: Saved partial or full assistant response to session ${sessionId} after stream ended.`);
                } catch(dbError) {
                    console.error("[AskService] DB: Failed to save assistant response after stream ended:", dbError);
                }
            }
        }
    }
}

const askService = new AskService();

module.exports = askService;