// jshint ignore: start

function getAEContext() {
    try {
        var proj = app.project;
        if (!proj) return '{"error": "Brak otwartego projektu"}';
        
        var comp = proj.activeItem;
        var hasComp = (comp !== null && comp instanceof CompItem);
        var pName = proj.file ? proj.file.name : "Untitled";
        var info = '{"hasActiveComp": ' + (hasComp ? "true" : "false");
        info += ', "projectName": "' + pName.replace(/"/g, '\\"') + '"';
        
        if (hasComp) {
            info += ', "compName": "' + (comp.name || "").replace(/"/g, '\\"') + '"';
            info += ', "width": ' + comp.width;
            info += ', "height": ' + comp.height;
            info += ', "duration": ' + comp.duration;
            info += ', "numLayers": ' + comp.numLayers;
            info += ', "selectedLayers": [';
            
            for (var i = 0; i < comp.selectedLayers.length; i++) {
                info += '{"index": ' + comp.selectedLayers[i].index + ', "name": "' + (comp.selectedLayers[i].name || "").replace(/"/g, '\\"') + '"}';
                if (i < comp.selectedLayers.length - 1) info += ',';
            }
            info += ']';
        }
        
        info += '}';
        return info;
    } catch (e) {
        return '{"error": "' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

function getDeepAEContext() {
    try {
        var proj = app.project;
        if (!proj) return '{"error": "Brak otwartego projektu"}';

        var esc = function(s) { return (s || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n'); };

        // --- Project items scan ---
        var comps = [];
        var folders = [];
        var footageItems = [];
        for (var i = 1; i <= proj.numItems; i++) {
            var item = proj.item(i);
            if (item instanceof CompItem) {
                comps.push('{"name":"' + esc(item.name) + '","w":' + item.width + ',"h":' + item.height + ',"fps":' + item.frameRate + ',"dur":' + item.duration.toFixed(2) + ',"layers":' + item.numLayers + '}');
            } else if (item instanceof FolderItem) {
                folders.push('"' + esc(item.name) + '"');
            } else if (item instanceof FootageItem) {
                var src = (item.file) ? esc(item.file.name) : "solid/placeholder";
                footageItems.push('{"name":"' + esc(item.name) + '","src":"' + src + '","w":' + (item.width || 0) + ',"h":' + (item.height || 0) + '}');
            }
        }

        var result = '{"projectName":"' + esc(proj.file ? proj.file.name : "Untitled") + '"';
        result += ',"comps":[' + comps.join(',') + ']';
        result += ',"folders":[' + folders.join(',') + ']';
        result += ',"footage":[' + footageItems.join(',') + ']';

        // --- Active comp deep scan ---
        var comp = proj.activeItem;
        if (comp && comp instanceof CompItem) {
            result += ',"activeComp":"' + esc(comp.name) + '"';
            var layers = [];
            var maxLayers = Math.min(comp.numLayers, 30); // cap to avoid huge payloads
            for (var j = 1; j <= maxLayers; j++) {
                var layer = comp.layer(j);
                var lInfo = '{"i":' + j + ',"name":"' + esc(layer.name) + '","type":"';

                if (layer instanceof TextLayer) lInfo += 'text';
                else if (layer instanceof ShapeLayer) lInfo += 'shape';
                else if (layer instanceof CameraLayer) lInfo += 'camera';
                else if (layer instanceof LightLayer) lInfo += 'light';
                else if (layer.nullLayer) lInfo += 'null';
                else if (layer.adjustmentLayer) lInfo += 'adjustment';
                else lInfo += 'av';

                lInfo += '","enabled":' + (layer.enabled ? 'true' : 'false');
                lInfo += ',"in":' + layer.inPoint.toFixed(2) + ',"out":' + layer.outPoint.toFixed(2);

                // Effects
                if (layer.property("ADBE Effect Parade") && layer.property("ADBE Effect Parade").numProperties > 0) {
                    var efx = [];
                    var ep = layer.property("ADBE Effect Parade");
                    var maxEfx = Math.min(ep.numProperties, 10);
                    for (var k = 1; k <= maxEfx; k++) {
                        efx.push('"' + esc(ep.property(k).name) + '"');
                    }
                    lInfo += ',"effects":[' + efx.join(',') + ']';
                }

                // Expression on opacity (common indicator)
                try {
                    if (layer.opacity && layer.opacity.expression && layer.opacity.expression.length > 0) {
                        lInfo += ',"hasExpr":true';
                    }
                } catch(ex) {}

                // Text content
                if (layer instanceof TextLayer) {
                    try {
                        var textDoc = layer.property("ADBE Text Properties").property("ADBE Text Document").value;
                        lInfo += ',"text":"' + esc(textDoc.text.substring(0, 50)) + '"';
                        lInfo += ',"font":"' + esc(textDoc.font) + '"';
                        lInfo += ',"fontSize":' + textDoc.fontSize;
                    } catch(ex2) {}
                }

                lInfo += '}';
                layers.push(lInfo);
            }
            result += ',"layers":[' + layers.join(',') + ']';
            if (comp.numLayers > 30) {
                result += ',"layersCapped":true,"totalLayers":' + comp.numLayers;
            }
        }

        result += '}';
        return result;
    } catch (e) {
        return '{"error": "DeepScan: ' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

function getAESnapshot() {
    try {
        var proj = app.project;
        if (!proj) return "NO_COMP";
        var comp = proj.activeItem;
        if (!comp || !(comp instanceof CompItem)) return "NO_COMP";
        
        var f = new File(Folder.temp.fsName + "/aisist_snapshot_" + new Date().getTime() + ".png");
        comp.saveFrameToPng(comp.time, f);
        return f.fsName;
    } catch (e) {
        return "ERROR: " + e.toString();
    }
}

function importAndAddToComp(filePath) {
    try {
        var proj = app.project;
        if (!proj) return "ERROR: Brak projektu";
        
        var ioFile = new File(filePath);
        if (!ioFile.exists) return "ERROR: Plik nie istnieje na dysku: " + filePath;
        
        var importOptions = new ImportOptions(ioFile);
        importOptions.sequence = false;
        importOptions.forceAlphabetical = false;
        
        if (!importOptions.canImportAs(ImportAsType.FOOTAGE)) {
            return "ERROR: Plik nie jest rozpoznawany przez AE jako Footage - " + filePath;
        }
        
        var beforeItems = proj.numItems;
        var footageItem = proj.importFile(importOptions);
        
        if (!footageItem || typeof footageItem.name === 'undefined') {
            if (proj.numItems > beforeItems) {
                for (var i = 1; i <= proj.numItems; i++) {
                    if (proj.item(i).name.indexOf(ioFile.name) !== -1 || (proj.item(i).file && proj.item(i).file.fsName === ioFile.fsName)) {
                        footageItem = proj.item(i);
                        break;
                    }
                }
            }
        }
        
        if (!footageItem || typeof footageItem.name === 'undefined') {
            return "ERROR: importFile nie zwrocil poprawnego obiektu.";
        }
        
        // Only add to comp if one is already active - do NOT create new comp per import
        var comp = proj.activeItem;
        if (comp && comp instanceof CompItem) {
            var layer = comp.layers.add(footageItem);
            return "Zaimportowano i dodano do kompozycji: " + layer.name;
        } else {
            return "Zaimportowano do projektu (brak aktywnej kompozycji): " + footageItem.name;
        }
    } catch (e) {
        return "ERROR: " + e.toString();
    }
}

// Helper: returns unique comp name by appending number if name already exists
function getUniqueCompName(baseName) {
    var proj = app.project;
    if (!proj) return baseName;
    var existing = {};
    for (var i = 1; i <= proj.numItems; i++) {
        if (proj.item(i) instanceof CompItem) {
            existing[proj.item(i).name] = true;
        }
    }
    if (!existing[baseName]) return baseName;
    var n = 2;
    while (existing[baseName + " " + n]) { n++; }
    return baseName + " " + n;
}

// Defensive Undo-Group wrapper.
// Opens ONE undo group "HEXART.PL/AfterALL Action" around the user script.
// If the user script imbalances begin/end calls, we detect drift and clean up so the
// project history stays consistent.
function runAgentCode(codeString) {
    var ourGroupOpen = false;
    var openCountBefore = 0;
    var nestedWarning = "";

    // Count user-script begin/end markers heuristically. ExtendScript has no API
    // to inspect the undo-group stack depth, so we lint the source string instead.
    try {
        var beginMatches = codeString.match(/app\.beginUndoGroup\s*\(/g);
        var endMatches = codeString.match(/app\.endUndoGroup\s*\(/g);
        var beginCount = beginMatches ? beginMatches.length : 0;
        var endCount = endMatches ? endMatches.length : 0;
        if (beginCount !== endCount) {
            nestedWarning = "Skrypt ma niezbalansowane wywolania UndoGroup (begin=" + beginCount + ", end=" + endCount + "). Wrapper sprobuje to naprawic, ale popraw kod w nastepnym kroku.";
        } else if (beginCount > 0) {
            nestedWarning = "Skrypt zawiera wlasne grupy UndoGroup (" + beginCount + "). Niepotrzebne - wrapper juz otwiera grupe.";
        }
    } catch (lintErr) { /* ignore lint failure */ }

    try {
        app.beginUndoGroup("HEXART.PL/AfterALL Action");
        ourGroupOpen = true;
        var result = eval(codeString);
        // Successful eval - now close OUR group. If the script left extra groups
        // open (unbalanced), we attempt best-effort cleanup: call endUndoGroup
        // additional times until it throws (no more groups to close).
        try {
            app.endUndoGroup();
            ourGroupOpen = false;
        } catch (_endErr) { ourGroupOpen = false; }
        // Defensive flush of any leaked groups (max 5 attempts to avoid infinite loop)
        for (var k = 0; k < 5; k++) {
            try { app.endUndoGroup(); } catch (__) { break; }
        }

        var resStr = (result === undefined || result === null) ? "Done" : result.toString();
        resStr = resStr.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
        if (nestedWarning) {
            return '{"success": true, "result": "' + resStr + '", "warning": "' + nestedWarning.replace(/"/g, '\\"') + '"}';
        }
        return '{"success": true, "result": "' + resStr + '"}';
    } catch (e) {
        // Error path: close any open groups, then rollback our wrapper's group.
        try {
            if (ourGroupOpen) {
                // Close possibly-nested groups first (max 5)
                for (var z = 0; z < 5; z++) {
                    try { app.endUndoGroup(); } catch (__2) { break; }
                }
                ourGroupOpen = false;
                // Now rollback the changes performed by the script (one Undo step)
                if (app.project) {
                    app.executeCommand(app.findMenuCommandId("Undo"));
                }
            }
        } catch (_) {}
        var errStr = e.toString().replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
        var lineNum = (e.line || e.lineNumber || 0);
        var fullErr = errStr;
        if (nestedWarning) fullErr = nestedWarning + " | " + errStr;
        return '{"success": false, "error": "' + fullErr.replace(/"/g, '\\"') + '", "line": ' + lineNum + '}';
    }
}

// Temp-file transport variant - safer than inline base64 (no eval-size limit).
// Reads the script from a file path and dispatches to runAgentCode().
function runAgentCodeFromFile(filePath) {
    var tmpFile = null;
    try {
        tmpFile = new File(filePath);
        if (!tmpFile.exists) {
            return '{"success": false, "error": "Tmp script file not found: ' + filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '", "line": 0}';
        }
        tmpFile.encoding = 'UTF-8';
        tmpFile.open('r');
        var code = tmpFile.read();
        tmpFile.close();
        // Try to remove temp file (best-effort)
        try { tmpFile.remove(); } catch(_) {}
        return runAgentCode(code);
    } catch (e) {
        try { if (tmpFile) tmpFile.close(); } catch(_) {}
        var errStr = e.toString().replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
        return '{"success": false, "error": "File transport failed: ' + errStr + '", "line": 0}';
    }
}

// Legacy base64 transport - kept for backward compat in case file transport is denied.
// Uses small ASCII-only base64 decoder.
function runAgentCodeB64(b64) {
    try {
        var keyStr = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
        var input = String(b64).replace(/[^A-Za-z0-9\+\/\=]/g, "");
        var output = "";
        var i = 0;
        while (i < input.length) {
            var e1 = keyStr.indexOf(input.charAt(i++));
            var e2 = keyStr.indexOf(input.charAt(i++));
            var e3 = keyStr.indexOf(input.charAt(i++));
            var e4 = keyStr.indexOf(input.charAt(i++));
            output += String.fromCharCode((e1 << 2) | (e2 >> 4));
            if (e3 != 64) output += String.fromCharCode(((e2 & 15) << 4) | (e3 >> 2));
            if (e4 != 64) output += String.fromCharCode(((e3 & 3) << 6) | e4);
        }
        // UTF-8 decode
        var utf8 = "";
        var j = 0;
        while (j < output.length) {
            var c = output.charCodeAt(j);
            if (c < 128) { utf8 += String.fromCharCode(c); j++; }
            else if (c > 191 && c < 224) {
                utf8 += String.fromCharCode(((c & 31) << 6) | (output.charCodeAt(j+1) & 63));
                j += 2;
            } else {
                utf8 += String.fromCharCode(((c & 15) << 12) | ((output.charCodeAt(j+1) & 63) << 6) | (output.charCodeAt(j+2) & 63));
                j += 3;
            }
        }
        return runAgentCode(utf8);
    } catch (e) {
        var errStr = e.toString().replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
        return '{"success": false, "error": "B64 decode failed: ' + errStr + '", "line": 0}';
    }
}

// --- Checkpoint System ---
function getProjectCheckpoint() {
    try {
        var proj = app.project;
        if (!proj) return '{"error":"No project"}';
        var esc = function(s) { return (s || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"'); };
        var totalItems = proj.numItems;
        var comps = [];
        for (var i = 1; i <= totalItems; i++) {
            var item = proj.item(i);
            if (item instanceof CompItem) {
                var layerNames = [];
                var maxL = Math.min(item.numLayers, 50);
                for (var j = 1; j <= maxL; j++) {
                    layerNames.push('"' + esc(item.layer(j).name) + '"');
                }
                comps.push('{"name":"' + esc(item.name) + '","layers":' + item.numLayers + ',"layerNames":[' + layerNames.join(',') + ']}');
            }
        }
        return '{"totalItems":' + totalItems + ',"comps":[' + comps.join(',') + ']}';
    } catch (e) {
        return '{"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

function compareCheckpoint(snapshotJSON) {
    try {
        var prev = eval('(' + snapshotJSON + ')');
        var proj = app.project;
        if (!proj) return '{"error":"No project"}';
        var esc = function(s) { return (s || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"'); };
        var diffs = [];

        var currentTotal = proj.numItems;
        if (currentTotal !== prev.totalItems) {
            diffs.push('"itemCount: ' + prev.totalItems + ' -> ' + currentTotal + '"');
        }

        // Build current comp map
        var currentComps = {};
        for (var i = 1; i <= currentTotal; i++) {
            var item = proj.item(i);
            if (item instanceof CompItem) {
                currentComps[item.name] = item.numLayers;
            }
        }

        // Check for missing/changed comps
        for (var c = 0; c < prev.comps.length; c++) {
            var pc = prev.comps[c];
            if (currentComps[pc.name] === undefined) {
                diffs.push('"MISSING comp: ' + esc(pc.name) + '"');
            } else if (currentComps[pc.name] !== pc.layers) {
                diffs.push('"comp ' + esc(pc.name) + ' layers: ' + pc.layers + ' -> ' + currentComps[pc.name] + '"');
            }
        }

        if (diffs.length === 0) {
            return '{"clean":true}';
        }
        return '{"clean":false,"diffs":[' + diffs.join(',') + ']}';
    } catch (e) {
        return '{"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

// --- Render Preview (Multi-frame) ---
function getMultiFramePreview(numFrames) {
    try {
        var proj = app.project;
        if (!proj) return '{"error":"No project"}';
        var comp = proj.activeItem;
        if (!comp || !(comp instanceof CompItem)) return '{"error":"No active comp"}';

        var frames = [];
        var n = parseInt(numFrames, 10) || 4;
        if (n < 2) n = 2;
        if (n > 8) n = 8;
        var step = comp.duration / (n + 1);

        for (var i = 1; i <= n; i++) {
            var t = step * i;
            if (t >= comp.duration) t = comp.duration - 0.01;
            var f = new File(Folder.temp.fsName + "/aisist_preview_" + i + "_" + new Date().getTime() + ".png");
            comp.saveFrameToPng(t, f);
            frames.push('{"time":' + t.toFixed(2) + ',"path":"' + f.fsName.replace(/\\/g, '\\\\') + '"}');
        }
        return '{"frames":[' + frames.join(',') + ']}';
    } catch (e) {
        return '{"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

// ===== Import multiple files to project =====
function importFilesToProject(pathsJSON) {
    try {
        var paths = eval("(" + pathsJSON + ")");
        var results = [];
        for (var i = 0; i < paths.length; i++) {
            try {
                var f = new File(paths[i]);
                if (!f.exists) {
                    results.push("NOT_FOUND:" + paths[i]);
                    continue;
                }
                var opts = new ImportOptions(f);
                var importedItem = app.project.importFile(opts);
                results.push("OK:" + importedItem.name);
            } catch(e) {
                results.push("ERR:" + e.message);
            }
        }
        return results.join("|");
    } catch(e) { return "PARSE_ERR:" + e.message; }
}

// ===== Get project folder path =====
function getProjectFolder() {
    if (app.project.file) {
        return app.project.file.parent.fsName;
    }
    return "NO_PROJECT_SAVED";
}

// ===== Project save state =====
// Returns JSON: { saved: bool, modified: bool, folder: string, file: string, name: string }
// "saved"  = project has been saved at least once (app.project.file is non-null)
// "modified" = project has unsaved changes since last save
function getProjectSaveStatus() {
    try {
        var proj = app.project;
        if (!proj) return '{"saved":false,"modified":false,"folder":"","file":"","name":""}';
        var esc = function(s) { return (s || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"'); };
        var saved = !!proj.file;
        // dirty flag — best-effort detection
        var modified = false;
        try { modified = !!proj.dirty; } catch (e) {}
        var folder = "", file = "", name = "";
        if (saved) {
            try { file = proj.file.fsName; } catch (e) {}
            try { folder = proj.file.parent.fsName; } catch (e) {}
            try { name = proj.file.name; } catch (e) {}
        }
        return '{"saved":' + (saved ? 'true' : 'false')
             + ',"modified":' + (modified ? 'true' : 'false')
             + ',"folder":"' + esc(folder) + '"'
             + ',"file":"' + esc(file) + '"'
             + ',"name":"' + esc(name) + '"}';
    } catch (e) {
        return '{"saved":false,"modified":false,"folder":"","file":"","name":"","error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

// Triggers AE's native Save / Save-As dialog. If forceDialog=true, always opens Save As.
// Returns JSON: { saved: bool, file: string, cancelled: bool }
function saveProjectInteractive(forceDialog) {
    try {
        var proj = app.project;
        if (!proj) return '{"saved":false,"cancelled":true,"error":"No project"}';
        var hadFile = !!proj.file;
        if (forceDialog || !hadFile) {
            // Show OS Save-As dialog
            var newFile = proj.file ? proj.file : new File("~/Desktop/Untitled.aep");
            var picked = newFile.saveDlg("Save HEXART.PL/AfterALL project", "After Effects Project:*.aep");
            if (!picked) return '{"saved":false,"cancelled":true}';
            proj.save(picked);
        } else {
            // Just save in place
            proj.save();
        }
        var esc = function(s) { return (s || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"'); };
        var f = proj.file ? proj.file.fsName : "";
        return '{"saved":true,"cancelled":false,"file":"' + esc(f) + '"}';
    } catch (e) {
        return '{"saved":false,"cancelled":false,"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

// ===== Asset Snapshot (for protection / undo tracking) =====
// Returns names of all project items and per-comp layer names that exist
// at the moment of the call. Compared later to classify deletions.
function getAssetSnapshot() {
    try {
        var proj = app.project;
        if (!proj) return '{"items":[],"layers":{},"file":null}';
        var esc = function(s) { return (s || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"'); };

        var items = [];
        var layersByComp = {};
        for (var i = 1; i <= proj.numItems; i++) {
            var item = proj.item(i);
            var name = item.name;
            items.push('"' + esc(name) + '"');
            if (item instanceof CompItem) {
                var layerNames = [];
                var maxL = Math.min(item.numLayers, 200);
                for (var j = 1; j <= maxL; j++) {
                    layerNames.push('"' + esc(item.layer(j).name) + '"');
                }
                layersByComp[name] = layerNames;
            }
        }
        var layersJSON = '';
        var first = true;
        for (var k in layersByComp) {
            if (!layersByComp.hasOwnProperty(k)) continue;
            if (!first) layersJSON += ',';
            layersJSON += '"' + esc(k) + '":[' + layersByComp[k].join(',') + ']';
            first = false;
        }
        var filePath = (proj.file) ? proj.file.fsName : "";
        return '{"items":[' + items.join(',') + '],"layers":{' + layersJSON + '},"file":"' + esc(filePath) + '","ts":' + (new Date().getTime()) + '}';
    } catch (e) {
        return '{"items":[],"layers":{},"file":null,"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

// ===== List all footage items with full paths =====
function listFootagePaths() {
    var items = [];
    for (var i = 1; i <= app.project.numItems; i++) {
        var item = app.project.item(i);
        if (item instanceof FootageItem && item.file) {
            items.push(item.name + "|" + item.file.fsName);
        }
    }
    return items.join("\n");
}
