//! SWEREF 99 TM (EPSG:3006) <-> WGS84, with Lantmäteriet's Gauss-Krüger series
//! ("Gauss Conformal Projection (Transverse Mercator)", Krüger's formulas). Accurate to
//! well under a millimetre in Sweden, so no PROJ dependency is needed.

const A: f64 = 6_378_137.0;
const F: f64 = 1.0 / 298.257_222_101; // GRS 80
const LON0: f64 = 15.0;
const K0: f64 = 0.9996;
const FE: f64 = 500_000.0;

struct Consts {
    e2: f64,
    a_hat: f64,
    beta: [f64; 4],
    delta: [f64; 4],
}

fn consts() -> Consts {
    let e2 = F * (2.0 - F);
    let n = F / (2.0 - F);
    let (n2, n3, n4) = (n * n, n * n * n, n * n * n * n);
    Consts {
        e2,
        a_hat: A / (1.0 + n) * (1.0 + n2 / 4.0 + n4 / 64.0),
        beta: [
            n / 2.0 - 2.0 * n2 / 3.0 + 5.0 * n3 / 16.0 + 41.0 * n4 / 180.0,
            13.0 * n2 / 48.0 - 3.0 * n3 / 5.0 + 557.0 * n4 / 1440.0,
            61.0 * n3 / 240.0 - 103.0 * n4 / 140.0,
            49561.0 * n4 / 161_280.0,
        ],
        delta: [
            n / 2.0 - 2.0 * n2 / 3.0 + 37.0 * n3 / 96.0 - n4 / 360.0,
            n2 / 48.0 + n3 / 15.0 - 437.0 * n4 / 1440.0,
            17.0 * n3 / 480.0 - 37.0 * n4 / 840.0,
            4397.0 * n4 / 161_280.0,
        ],
    }
}

/// (lon, lat) in degrees -> (easting, northing) in metres.
pub fn forward(lon: f64, lat: f64) -> (f64, f64) {
    let c = consts();
    let (e2, e4, e6, e8) = (c.e2, c.e2.powi(2), c.e2.powi(3), c.e2.powi(4));
    let a = e2;
    let b = (5.0 * e4 - e6) / 6.0;
    let cc = (104.0 * e6 - 45.0 * e8) / 120.0;
    let d = 1237.0 * e8 / 1260.0;
    let phi = lat.to_radians();
    let s2 = phi.sin().powi(2);
    let phi_s = phi - phi.sin() * phi.cos() * (a + b * s2 + cc * s2 * s2 + d * s2 * s2 * s2);
    let dl = (lon - LON0).to_radians();
    let xi = (phi_s.tan() / dl.cos()).atan();
    let eta = (phi_s.cos() * dl.sin()).atanh();
    let mut x = xi;
    let mut y = eta;
    for (j, bj) in c.beta.iter().enumerate() {
        let k = 2.0 * (j as f64 + 1.0);
        x += bj * (k * xi).sin() * (k * eta).cosh();
        y += bj * (k * xi).cos() * (k * eta).sinh();
    }
    (K0 * c.a_hat * y + FE, K0 * c.a_hat * x)
}

/// (easting, northing) in metres -> (lon, lat) in degrees.
pub fn inverse(e: f64, n: f64) -> (f64, f64) {
    let c = consts();
    let (e2, e4, e6, e8) = (c.e2, c.e2.powi(2), c.e2.powi(3), c.e2.powi(4));
    let xi = n / (K0 * c.a_hat);
    let eta = (e - FE) / (K0 * c.a_hat);
    let mut xp = xi;
    let mut ep = eta;
    for (j, dj) in c.delta.iter().enumerate() {
        let k = 2.0 * (j as f64 + 1.0);
        xp -= dj * (k * xi).sin() * (k * eta).cosh();
        ep -= dj * (k * xi).cos() * (k * eta).sinh();
    }
    let phi_s = (xp.sin() / ep.cosh()).asin();
    let dl = (ep.sinh() / xp.cos()).atan();
    let a = e2 + e4 + e6 + e8;
    let b = -(7.0 * e4 + 17.0 * e6 + 30.0 * e8) / 6.0;
    let cc = (224.0 * e6 + 889.0 * e8) / 120.0;
    let d = -(4279.0 * e8) / 1260.0;
    let s2 = phi_s.sin().powi(2);
    let phi = phi_s + phi_s.sin() * phi_s.cos() * (a + b * s2 + cc * s2 * s2 + d * s2 * s2 * s2);
    (LON0 + dl.to_degrees(), phi.to_degrees())
}

/// Bounding box in SWEREF 99 TM (min E, min N, max E, max N) of a WGS84 bbox [w, s, e, n].
pub fn bbox_tm(b: [f64; 4]) -> (f64, f64, f64, f64) {
    let corners =
        [(b[0], b[1]), (b[0], b[3]), (b[2], b[1]), (b[2], b[3])].map(|(lo, la)| forward(lo, la));
    let min_e = corners.iter().map(|c| c.0).fold(f64::INFINITY, f64::min);
    let max_e = corners
        .iter()
        .map(|c| c.0)
        .fold(f64::NEG_INFINITY, f64::max);
    let min_n = corners.iter().map(|c| c.1).fold(f64::INFINITY, f64::min);
    let max_n = corners
        .iter()
        .map(|c| c.1)
        .fold(f64::NEG_INFINITY, f64::max);
    (min_e, min_n, max_e, max_n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_proj() {
        // reference values from proj4js with +proj=utm +zone=33 +ellps=GRS80
        for (lon, lat, pe, pn) in [
            (13.7, 56.15, 419_238.777, 6_223_535.347),
            (20.5, 67.8, 731_654.947, 7_530_870.950),
        ] {
            let (e, n) = forward(lon, lat);
            assert!(
                (e - pe).abs() < 0.002 && (n - pn).abs() < 0.002,
                "{lon},{lat}: {e},{n}"
            );
            let (lo, la) = inverse(e, n);
            assert!(
                (lo - lon).abs() < 1e-9 && (la - lat).abs() < 1e-9,
                "inverse {lo},{la}"
            );
        }
    }
}
