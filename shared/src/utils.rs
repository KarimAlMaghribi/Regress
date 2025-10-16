//! Utility helpers used throughout the backend services.

use rhai::{Engine, Scope};

/// Evaluates a Rhai expression and returns a boolean result.
pub fn rhai_eval_bool(expr: &str, vars: &std::collections::HashMap<String, rhai::Dynamic>) -> anyhow::Result<bool> {
    let engine = Engine::new();
    let mut scope = Scope::new();
    for (k, v) in vars {
        scope.push_dynamic(k.to_string(), v.clone());
    }
    let result = engine
        .eval_with_scope::<bool>(&mut scope, expr)
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    Ok(result)
}

/// Evaluates a Rhai expression returning the resulting dynamic value.
pub fn eval_formula(expr: &str, vars: &std::collections::HashMap<String, rhai::Dynamic>) -> anyhow::Result<rhai::Dynamic> {
    let engine = Engine::new();
    let mut scope = Scope::new();
    for (k, v) in vars {
        scope.push_dynamic(k.to_string(), v.clone());
    }
    let result = engine
        .eval_with_scope::<rhai::Dynamic>(&mut scope, expr)
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn eval_true() {
        let mut map = std::collections::HashMap::new();
        map.insert("a".into(), rhai::Dynamic::from_int(1));
        assert!(rhai_eval_bool("a == 1", &map).unwrap());
    }

    #[test]
    fn formula_add() {
        let mut map = std::collections::HashMap::new();
        map.insert("a".into(), rhai::Dynamic::from_int(2));
        map.insert("b".into(), rhai::Dynamic::from_int(3));
        let res = eval_formula("a + b", &map).unwrap();
        assert_eq!(res.as_int().unwrap(), 5);
    }

    #[test]
    fn decision_bool() {
        let mut map = std::collections::HashMap::new();
        map.insert("x".into(), rhai::Dynamic::from_int(1));
        assert!(rhai_eval_bool("x == 1", &map).unwrap());
    }
}
