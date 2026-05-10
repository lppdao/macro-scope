mod parser;

use parser::{BoundaryInlayHint, CurrentScopeResponse, MacroIndex};
use serde::Deserialize;
use std::collections::HashMap;
use tokio::sync::RwLock;
use tower_lsp::jsonrpc::Result;
use tower_lsp::lsp_types::{
    DidChangeTextDocumentParams, DidCloseTextDocumentParams, DidOpenTextDocumentParams,
    InitializeParams, InitializeResult, InitializedParams, MessageType, Position,
    ServerCapabilities, TextDocumentIdentifier, TextDocumentSyncCapability, TextDocumentSyncKind,
};
use tower_lsp::{Client, LanguageServer, LspService, Server};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurrentScopeParams {
    text_document: TextDocumentIdentifier,
    position: Position,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoundaryInlayHintsParams {
    text_document: TextDocumentIdentifier,
    range: HintRange,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HintRange {
    start: Position,
    end: Position,
}

struct Backend {
    client: Client,
    documents: RwLock<HashMap<String, MacroIndex>>,
}

impl Backend {
    fn new(client: Client) -> Self {
        Self {
            client,
            documents: RwLock::new(HashMap::new()),
        }
    }

    async fn current_scope(&self, params: CurrentScopeParams) -> Result<CurrentScopeResponse> {
        let documents = self.documents.read().await;
        let uri = params.text_document.uri.to_string();
        let response = documents
            .get(&uri)
            .map(|index| index.current_scope(params.position.line, params.position.character))
            .unwrap_or_else(|| {
                CurrentScopeResponse::empty(params.position.line, params.position.character)
            });
        Ok(response)
    }

    async fn boundary_inlay_hints(
        &self,
        params: BoundaryInlayHintsParams,
    ) -> Result<Vec<BoundaryInlayHint>> {
        let documents = self.documents.read().await;
        let uri = params.text_document.uri.to_string();
        let hints = documents
            .get(&uri)
            .map(|index| index.boundary_inlay_hints(params.range.start.line, params.range.end.line))
            .unwrap_or_default();
        Ok(hints)
    }

    async fn parse_document(&self, uri: String, text: String) {
        let index = MacroIndex::parse(&text);
        self.documents.write().await.insert(uri, index);
    }
}

#[tower_lsp::async_trait]
impl LanguageServer for Backend {
    async fn initialize(&self, _: InitializeParams) -> Result<InitializeResult> {
        Ok(InitializeResult {
            capabilities: ServerCapabilities {
                text_document_sync: Some(TextDocumentSyncCapability::Kind(
                    TextDocumentSyncKind::FULL,
                )),
                ..ServerCapabilities::default()
            },
            server_info: None,
        })
    }

    async fn initialized(&self, _: InitializedParams) {
        self.client
            .log_message(MessageType::INFO, "Macro Scope language server initialized")
            .await;
    }

    async fn shutdown(&self) -> Result<()> {
        Ok(())
    }

    async fn did_open(&self, params: DidOpenTextDocumentParams) {
        self.parse_document(
            params.text_document.uri.to_string(),
            params.text_document.text,
        )
        .await;
    }

    async fn did_change(&self, params: DidChangeTextDocumentParams) {
        if let Some(change) = params.content_changes.into_iter().next() {
            self.parse_document(params.text_document.uri.to_string(), change.text)
                .await;
        }
    }

    async fn did_close(&self, params: DidCloseTextDocumentParams) {
        self.documents
            .write()
            .await
            .remove(&params.text_document.uri.to_string());
    }
}

#[tokio::main]
async fn main() {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    let (service, socket) = LspService::build(Backend::new)
        .custom_method("macroScope/currentScope", Backend::current_scope)
        .custom_method(
            "macroScope/boundaryInlayHints",
            Backend::boundary_inlay_hints,
        )
        .finish();
    Server::new(stdin, stdout, socket).serve(service).await;
}
