function make_icon(outFile)
%MAKE_ICON Builds media/icon.png (256x256, transparent corners).
%   Step 1 renders a glossy MATLAB-style surface with MATLAB graphics (an original surface with two peaks,
%   deliberately not the MathWorks membrane logo). Step 2 post-processes it: the surface on a transparent
%   background (no tile, like MATLAB's own logo) and the vinyl record (this extension's symbol) on top. Everything is drawn at 4x and
%   averaged down, for smooth edges. Base MATLAB only.
%   Run from the repository root:  matlab -batch "addpath('scripts/icon'); make_icon('media/icon.png')"
if nargin < 1, outFile = fullfile('media', 'icon.png'); end
S = 1024;                                   % working size (4x the 256 px icon)
[srf, srfA] = renderSurface(900);
img = zeros(S, S, 3); alpha = zeros(S, S); % premultiplied RGB + alpha; no background (transparent)
[img, alpha] = placeLayer(img, alpha, srf, srfA, [470 470], 940, 800);
[img, alpha] = drawVinyl(img, alpha, 790, 790, 190);
[rgb, a] = shrink(img, alpha, 4);
imwrite(rgb, outFile, 'Alpha', a);
fprintf('wrote %s (%dx%d)\n', outFile, size(rgb, 2), size(rgb, 1));
end

% ---- step 1: the surface, with MATLAB graphics ----

function [rgb, a] = renderSurface(px)
% Rendered on black and on white; the difference gives the exact transparency (also of the anti-aliased edge).
[x, y] = meshgrid(linspace(0, 1, 241));
g = @(cx, cy, sx, sy) exp(-((x - cx).^2 / sx + (y - cy).^2 / sy));
z = 1.00 * g(0.36, 0.52, 0.020, 0.060) ...    % the tall peak
  + 0.50 * g(0.70, 0.40, 0.015, 0.050) ...    % a smaller one
  - 0.12 * g(0.55, 0.75, 0.015, 0.050);       % a shallow dip
f = figure('Visible', 'off', 'Units', 'pixels', 'Position', [0 0 px px], 'Color', 'k');
ax = axes(f, 'Position', [0 0 1 1], 'Color', 'none');
s = surf(ax, x, y, z, 'EdgeColor', 'none', 'FaceColor', 'interp', 'FaceLighting', 'gouraud');
colormap(ax, heat(256));
clim(ax, [0 1.0]);
axis(ax, 'off');
set(ax, 'DataAspectRatio', [1 1 0.85]);
view(ax, -32, 26);
material(s, [0.45 0.75 0.9 12 0.6]);         % ambient, diffuse, specular, exponent, specular colour: glossy
light(ax, 'Position', [-1.0 0.6 1.4], 'Color', [1.00 0.88 0.75]);   % warm key light, upper left
light(ax, 'Position', [ 1.2 -1.0 0.25], 'Color', [0.25 0.45 1.00]); % blue rim light, low right
onBlack = shot(ax, [0 0 0]);
onWhite = shot(ax, [1 1 1]);
close(f);
a = 1 - mean(onWhite - onBlack, 3);
a = min(max(a, 0), 1);
rgb = onBlack;                              % on black, colour x alpha = premultiplied colour
end

function im = shot(ax, bg)
file = [tempname '.png'];
exportgraphics(ax, file, 'Resolution', 150, 'BackgroundColor', bg);
im = im2double(imread(file));
delete(file);
end

function m = heat(n)
% dark red -> red-orange -> orange -> warm yellow
% the flat sheet blue-grey (like MATLAB's plots), the peaks red-orange -> warm yellow
stops = [0.00 0.36 0.50 0.70
         0.06 0.62 0.24 0.12
         0.30 0.88 0.30 0.05
         0.65 1.00 0.56 0.10
         1.00 1.00 0.86 0.45];
t = linspace(0, 1, n)';
m = [interp1(stops(:,1), stops(:,2), t), interp1(stops(:,1), stops(:,3), t), interp1(stops(:,1), stops(:,4), t)];
end

% ---- step 2: post-processing ----

function [img, alpha] = placeLayer(img, alpha, rgb, a, centre, maxW, maxH)
% Crop the layer to what is visible, scale it to fit maxW x maxH, and composite it centred at centre ([x y]).
rows = find(any(a > 0.02, 2)); cols = find(any(a > 0.02, 1));
rgb = rgb(rows(1):rows(end), cols(1):cols(end), :); a = a(rows(1):rows(end), cols(1):cols(end));
k = min(maxW / size(a, 2), maxH / size(a, 1));
h = round(size(a, 1) * k); w = round(size(a, 2) * k);
[Xq, Yq] = meshgrid(linspace(1, size(a, 2), w), linspace(1, size(a, 1), h));
a2 = interp2(a, Xq, Yq, 'linear');
x0 = round(centre(1) - w / 2); y0 = round(centre(2) - h / 2);
ri = y0 + (1:h); ci = x0 + (1:w);
for c = 1:3
  layer = interp2(rgb(:,:,c), Xq, Yq, 'linear');            % premultiplied
  img(ri, ci, c) = layer + img(ri, ci, c) .* (1 - a2);
end
alpha(ri, ci) = a2 + alpha(ri, ci) .* (1 - a2);
end

function [img, alpha] = drawVinyl(img, alpha, cx, cy, R)
% The vinyl record: a transparent gap around it (cut out of the surface), a dark disc with grooves and a
% highlight, an orange label, and a see-through hole.
[X, Y] = meshgrid(1:size(img, 2), 1:size(img, 1));
d = hypot(X - cx, Y - cy);
gap = d <= R + 22;
img(repmat(gap, 1, 1, 3)) = 0; alpha(gap) = 0;
% dark disc, lighter towards the upper left
gd = hypot(X - (cx - 0.24 * R), Y - (cy - 0.36 * R)) / (1.6 * R);
light = hex('2b3037'); dark = hex('0c0e11');
disc = double(d <= R);
for c = 1:3
  col = light(c) + (dark(c) - light(c)) * min(gd, 1);
  img(:,:,c) = disc .* col + img(:,:,c) .* (1 - disc);
end
alpha = disc + alpha .* (1 - disc);
for rr = [19 16.8 14.6 12.4 10.4] / 21 * R  % grooves
  [img, alpha] = paint(img, alpha, abs(d - rr) <= 2.8, hex('3a3f47'));
end
% highlight arc, upper left
ang = atan2d(Y - cy, X - cx);
arc = abs(d - 17 / 21 * R) <= 6.5 & ang >= -150 & ang <= -105;
[img, alpha] = paint(img, alpha, arc, [1 1 1], 0.35);
% label and hole
[img, alpha] = paint(img, alpha, d <= 7.2 / 21 * R + 3.2, hex('c2410c'));
[img, alpha] = paint(img, alpha, d <= 7.2 / 21 * R - 3.2, hex('ff8c1a'));
hole = d <= 1.8 / 21 * R;
img(repmat(hole, 1, 1, 3)) = 0; alpha(hole) = 0;
end

function [img, alpha] = paint(img, alpha, mask, colour, opacity)
if nargin < 5, opacity = 1; end
m = double(mask) * opacity;
for c = 1:3
  img(:,:,c) = m * colour(c) + img(:,:,c) .* (1 - m);
end
alpha = m + alpha .* (1 - m);
end

function [rgb, a] = shrink(img, alpha, k)
% Average k x k blocks (premultiplied), then un-premultiply.
n = size(alpha, 1) / k;
blk = @(m) squeeze(mean(mean(reshape(m, k, n, k, n), 1), 3));
a = blk(alpha);
rgb = zeros(n, n, 3);
for c = 1:3
  rgb(:,:,c) = blk(img(:,:,c)) ./ max(a, eps);
end
rgb = min(max(rgb, 0), 1);
end

function c = hex(s)
c = double([hex2dec(s(1:2)) hex2dec(s(3:4)) hex2dec(s(5:6))]) / 255;
end
