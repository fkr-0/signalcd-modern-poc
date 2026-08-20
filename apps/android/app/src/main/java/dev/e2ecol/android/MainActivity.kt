package dev.e2ecol.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.weight
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

class MainActivity : ComponentActivity() {
    private val editorViewModel by viewModels<EditorViewModel>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        consumeJoinIntent(intent)
        setContent {
            MaterialTheme {
                val state by editorViewModel.state.collectAsStateWithLifecycle()
                EditorApp(
                    state = state,
                    onDocumentIdChange = editorViewModel::setDocumentId,
                    onSidecarUrlChange = editorViewModel::setSidecarUrl,
                    onDraftChange = editorViewModel::setDraftText,
                    onConnect = editorViewModel::connect,
                    onDisconnect = editorViewModel::disconnect,
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        consumeJoinIntent(intent)
    }

    private fun consumeJoinIntent(intent: Intent) {
        if (intent.action == Intent.ACTION_VIEW) intent.dataString?.let(editorViewModel::applyJoinLink)
    }
}

@Composable
private fun EditorApp(
    state: EditorUiState,
    onDocumentIdChange: (String) -> Unit,
    onSidecarUrlChange: (String) -> Unit,
    onDraftChange: (String) -> Unit,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("e2e-col")
                        Text("Android compatibility scaffold", style = MaterialTheme.typography.labelSmall)
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            ConnectionSummary(state)
            OutlinedTextField(
                value = state.sidecarUrl,
                onValueChange = onSidecarUrlChange,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Sidecar URL") },
                singleLine = true,
            )
            OutlinedTextField(
                value = state.documentId,
                onValueChange = onDocumentIdChange,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Document UUID") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onConnect, enabled = state.connection != ConnectionState.CONNECTING) {
                    Text(if (state.connection == ConnectionState.ONLINE) "Reconnect" else "Connect")
                }
                TextButton(onClick = onDisconnect, enabled = state.connection != ConnectionState.OFFLINE) {
                    Text("Disconnect")
                }
            }
            HorizontalDivider()
            OutlinedTextField(
                value = state.draftText,
                onValueChange = onDraftChange,
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                label = { Text("Local scaffold draft") },
                supportingText = {
                    Text("CRDT mutation/send stays disabled until the Automerge Android runtime passes cross-platform fixtures.")
                },
            )
        }
    }
}

@Composable
private fun ConnectionSummary(state: EditorUiState) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        tonalElevation = 2.dp,
        shape = MaterialTheme.shapes.medium,
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text("Transport: ${state.connection.name.lowercase()}", style = MaterialTheme.typography.titleSmall)
            state.groupId?.let { Text("Group: $it", style = MaterialTheme.typography.bodySmall) }
            state.inviter?.let { Text("Inviter: $it", style = MaterialTheme.typography.bodySmall) }
            state.lastFrame?.let { Text("Last validated frame: $it", style = MaterialTheme.typography.bodySmall) }
            state.message?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        }
    }
}
