/*
 * CraftScript to fill the region with terrain from RuneScape Classic.
 *
 * Based on:
 * - 2D-Landscape-Editor: https://github.com/Open-RSC/2D-Landscape-Editor
 * - rsc-landscape: https://github.com/2003scape/rsc-landscape
 *
 * Useful locations:
 * - Origin (top-left):     /tp 240 80 432
 *
 * ---
 *
 * USAGE:
 *
 *  /cs rsc_gen_terrain <landscape_filename> [--full|chunk]
 *
 * ---
 *
 * EXAMPLES:
 *
 * Generate the entire map:
 *
 *      /cs rsc_gen_terrain D:/tmp/rsc/Landscape.data --full
 *
 *      This may require a tweak to `worldedit.properties`:
 *      scripting-timeout=300000
 *
 *      Followed by:
 *      /worldedit reload
 *
 *      After generating the map it takes a long time for the chunks to update,
 *      and no other commands can be run in the meantime.
 *
 * Generate sector at the current chunk:
 *
 *      /cs rsc_gen_terrain D:/tmp/rsc/Landscape.data --chunk
 *
 * Generate sectors to fill the selected region:
 *
 *      /cs rsc_gen_terrain D:/tmp/rsc/Landscape.data
 */

importPackage(Packages.java.io);
importPackage(Packages.java.lang.reflect);
importPackage(Packages.java.nio);
importPackage(Packages.java.util.zip);
importPackage(Packages.com.sk89q.worldedit);
importPackage(Packages.com.sk89q.worldedit.math);
importPackage(Packages.com.sk89q.worldedit.blocks);

const SEA_LEVEL = 63;
const BEDROCK_LEVEL = 60;

const SECTOR_SIZE = 48;

// Sector filenames start from h0x48y37
const MIN_SECTOR_X = 48;
const MIN_SECTOR_Y = 37;

const MAX_SECTOR_X = 68;
const MAX_SECTOR_Y = 57;
const NUM_SECTORS_X = MAX_SECTOR_X - MIN_SECTOR_X;

////////////////////////////////////////////////////////////////////////////////
// Minecraft world
////////////////////////////////////////////////////////////////////////////////

function processSector(sectorX, sectorY, sector) {
    // Find the sector origin, converted to Minecraft's co-ordinate system
    var sectorMinBlockPos = getMinBlockPosForSector(sectorX, sectorY);

    // For each tile in the sector...
    for (var tileX = 0; tileX < SECTOR_SIZE; tileX++) {
        for (var tileY = 0; tileY < SECTOR_SIZE; tileY++) {
            var tile = sector[tileX][tileY];
            processTile(sectorMinBlockPos, tileX, tileY, tile);
        }
    }
}

function processTile(sectorMinBlockPos, tileX, tileY, tile) {
    // Find block position corresponding to tile (at lowest possible point)
    var basePos = getBlockPosForTile(sectorMinBlockPos, tileX, tileY);

    // Place bedrock as a base
    // TODO: Cache block types
    var bedrock = context.getBlock("bedrock");
    blocks.setBlock(basePos, bedrock);

    // Pick the block type based on the tile color
    var blockType = getBlockTypeFromPalette(tile.groundTexture);

    // Pick the block type to be used by any supporting blocks
    var supportType = blockType == context.getBlock("dirt_path")
        ? context.getBlock("dirt")
        : blockType;

    // RSC elevation seems to range from: 0 (highest point) to 256 (lowest point),
    // which we map to the range: 9 (highest point) to 1 (lowest point).
    var elevation = 5 + ((tile.groundElevation) / 32);

    // Place blocks up to the desired elevation
    for (var i = 1; i <= elevation; i++) {
        var blockPos = basePos.withY(BEDROCK_LEVEL + i);
        if (i < elevation) {
            blocks.setBlock(blockPos, supportType);
        } else {
            blocks.setBlock(blockPos, blockType);
        }
    }

    // Place overlay block
    if (tile.groundOverlay !== 0) {
        var overlayBlock = getOverlayBlock(tile.groundOverlay);
        if (overlayBlock) {
            var overlayBlockPos = basePos.withY(BEDROCK_LEVEL + elevation + 1);
            blocks.setBlock(overlayBlockPos, overlayBlock);
        }
    }
}

// See:
// https://github.com/Open-RSC/2D-Landscape-Editor/blob/main/src/main/java/org/openrsc/editor/gui/graphics/TileRenderer.java#L46
// https://github.com/2003scape/rsc-landscape/blob/master/src/terrain-colours.js
function getBlockTypeFromPalette(paletteIndex) {
    if (paletteIndex < 16) {
        return context.getBlock("stone");
    } else if (paletteIndex < 48) {
        return context.getBlock("lime_terracotta");
    } else if (paletteIndex < 80) {
        return context.getBlock("grass_block");
    } else if (paletteIndex < 96) {
        return context.getBlock("green_concrete_powder");
    } else if (paletteIndex < 104) {
        return context.getBlock("lime_terracotta");
    } else if (paletteIndex < 144) {
        return context.getBlock("dirt_path");
    } else if (paletteIndex < 164) {
        return context.getBlock("packed_mud");
    } else if (paletteIndex < 176) {
        return context.getBlock("dirt");
    } else if (paletteIndex < 208) {
        return context.getBlock("coarse_dirt");
    } else if (paletteIndex < 216) {
        return context.getBlock("podzol");
    }
    return context.getBlock("grass_block");
}

function getOverlayBlock(groundOverlay) {
    if (groundOverlay === 2) {
        // Water
        return context.getBlock("water");
    } else if (groundOverlay === 4) {
        // Bridge
        return context.getBlock("oak_planks");
    } else if (groundOverlay === 5) {
        // Swamp
        return context.getBlock("smooth_stone");
    } else if (groundOverlay === 7) {
        // Gnome Ball field - floor tiles..?
        return context.getBlock("muddy_mangrove_roots");
    } else if (groundOverlay === 20) {
        // Agility training area - log?
        return context.getBlock("oak_log");
    }
    //player.print("Unknown overlay: " + groundOverlay);
    return context.getBlock("red_wool");
}

////////////////////////////////////////////////////////////////////////////////
// Utilities
////////////////////////////////////////////////////////////////////////////////

function getContainingSectorCoords(blockPos) {
    // See: https://github.com/2003scape/rsc-landscape/blob/master/src/landscape.js#L173
    var sectorX = Math.floor(blockPos.getX() / SECTOR_SIZE);
    var sectorY = Math.floor(blockPos.getZ() / SECTOR_SIZE);

    // RuneScape and Minecraft use different co-ordinate systems so we have to
    // flip our x co-ordinates to prevent the world becoming mirrored.
    sectorX = NUM_SECTORS_X - sectorX;

    // In effect, adding MIN_SECTOR_X/Y offsets the entire RuneScape world
    // relative to the Minecraft world, so that we can start generating from
    // (0, 0). As far as I can tell it's a convenience, not a necessity.
    sectorX += MIN_SECTOR_X;
    sectorY += MIN_SECTOR_Y;

    return BlockVector3.at(sectorX, 0, sectorY);
}

function getSectorId(sectorX, sectorY) {
    return "h0x" + sectorX + "y" + sectorY;
}

function getMinBlockPosForSector(sectorX, sectorY) {
    // Convert from RuneScape -> Minecraft co-ordinates.
    // This is basically the opposite of `getContainingSectorCoords`.
    var mcSectorX = (sectorX - MIN_SECTOR_X);
    var mcSectorZ = (sectorY - MIN_SECTOR_Y);

    mcSectorX = -(mcSectorX - NUM_SECTORS_X);

    var blockX = mcSectorX * SECTOR_SIZE;
    var blockZ = mcSectorZ * SECTOR_SIZE;

    return BlockVector3.at(blockX, BEDROCK_LEVEL, blockZ);
}

function getBlockPosForTile(sectorMinBlockPos, tileX, tileY) {
    // Convert from RuneScape -> Minecraft co-ordinates (inverted x-axis)
    var blockX = sectorMinBlockPos.getX() + (SECTOR_SIZE - tileX - 1);
    var blockY = sectorMinBlockPos.getY();
    var blockZ = sectorMinBlockPos.getZ() + tileY;
    return BlockVector3.at(blockX, blockY, blockZ);
}

////////////////////////////////////////////////////////////////////////////////
// Data loading
////////////////////////////////////////////////////////////////////////////////

function loadLandscapeData(filename) {
    // Load ZIP file
    var file = new File(filename);
    if (!file.exists()) {
        player.printError("Specified landscape file does not exist");
    }
    return new ZipFile(file);
}

function loadSector(archive, sectorEntry) {
    buffer = streamToBuffer(new BufferedInputStream(archive.getInputStream(sectorEntry)));
    sector = new Array(SECTOR_SIZE);
    for (var x = 0; x < SECTOR_SIZE; x++) {
        sector[x] = new Array(SECTOR_SIZE);
        for (var y = 0; y < SECTOR_SIZE; y++) {
            // See: https://github.com/Open-RSC/2D-Landscape-Editor/blob/main/src/main/java/org/openrsc/editor/model/Tile.java#L206
            var tile = {}
            tile.groundElevation = toUnsigned(buffer.get());
            tile.groundTexture = toUnsigned(buffer.get());
            tile.groundOverlay = toUnsigned(buffer.get());
            tile.roofTexture = toUnsigned(buffer.get());
            tile.rightBorderWall = toUnsigned(buffer.get());
            tile.topBorderWall = toUnsigned(buffer.get());
            tile.diagonalWalls = buffer.getInt();
            sector[x][y] = tile;
        }
    }
    return sector;
}

function streamToBuffer(inputStream) {
    var size = inputStream.available();
    var buffer = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, size);
    for (var i = 0; i < size; i++) {
        buffer[i] = toSigned(inputStream.read());
    }

    // TODO: This would be more efficient but doesn't seem to work!
    //inputStream.read(buffer, 0, size);

    return ByteBuffer.wrap(buffer);
}

function toSigned(val) {
    if (val > 127) {
        val -= 256;
    }
    return val;
}

function toUnsigned(val) {
    if (val < 0) {
        val += 256;
    }
    return val;
}

////////////////////////////////////////////////////////////////////////////////
// Entry point
////////////////////////////////////////////////////////////////////////////////

function main() {
    context.checkArgs(1, 2, "<filename> [--full|chunk]");

    // Find relevant sectors
    var minSectorCoords;
    var maxSectorCoords;
    if (argv.length > 2) {
        if (argv[2].equals("--full")) {
            player.print("Attempting full map generation...");
            minSectorCoords = BlockVector3.at(MIN_SECTOR_X, 0, MIN_SECTOR_Y);
            maxSectorCoords = BlockVector3.at(MAX_SECTOR_X, 0, MAX_SECTOR_Y);
        } else if (argv[2].equals("--chunk")) {
            player.print("Attempting single chunk generation...");
            minSectorCoords = getContainingSectorCoords(player.getBlockLocation());
            maxSectorCoords = minSectorCoords;
        } else {
            player.printError("Unknown parameter: " + argv[2]);
            return;
        }
    } else {
        // Use selection
        player.print("Attempting generation from selection...");
        region = session.getRegionSelector(player.getWorld()).getRegion();
        var minRegionPos = region.getMinimumPoint();
        var maxRegionPos = region.getMaximumPoint();
        minSectorCoords = getContainingSectorCoords(minRegionPos);
        maxSectorCoords = getContainingSectorCoords(maxRegionPos);
    }

    // Load landscape data
    // TODO: We are currently loading a "Landscape.data" file but this is not the
    // original map format. We should be loading .jag and .mem files as seen here:
    // https://github.com/2003scape/rsc-landscape#example
    var landscapeArchive;
    try {
        landscapeArchive = loadLandscapeData(argv[1]);
    } catch (err) {
        player.printError("Error reading landscape data");
        player.printError(err);
        return;
    }

    // Process requested sectors
    for (var sectorX = minSectorCoords.getX(); sectorX <= maxSectorCoords.getX(); sectorX++) {
        for (var sectorY = minSectorCoords.getZ(); sectorY <= maxSectorCoords.getZ(); sectorY++) {
            var sectorId = getSectorId(sectorX, sectorY);
            var sectorEntry = landscapeArchive.getEntry(sectorId);
            if (sectorEntry) {

                player.print("Loading sector: " + sectorId);
                var sector = loadSector(landscapeArchive, sectorEntry);

                player.print("Processing sector: " + sectorId);
                processSector(sectorX, sectorY, sector);

            } else {
                player.printError("Invalid sector: " + sectorId);
            }
        }
    }
}

var blocks = context.remember();
var session = context.getSession();
var player = context.getPlayer();
var region;

main();
